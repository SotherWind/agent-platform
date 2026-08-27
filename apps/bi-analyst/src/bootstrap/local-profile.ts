import { MemorySaver } from "@langchain/langgraph";
import type Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/types.js";
import type { RuntimeProfile } from "../config/types.js";
import {
  FilePolicyProvider,
  InMemoryPolicyProvider,
  withAuthorizedDataSources,
  type PolicyProvider,
} from "../policy/policy-provider.js";
import { createDefaultAccessPolicy } from "../policy/access-policy.js";
import { createHttpPolicyProviderFromEnv } from "../policy/http-policy-provider.js";
import { InMemoryAuditStore } from "../audit/store.js";
import { SqliteAuditStore } from "../audit/sqlite-store.js";
import { createLocalAuditSink } from "../audit/sink.js";
import { InMemoryQueryHistoryStore } from "../history/store.js";
import { SqliteQueryHistoryStore } from "../history/sqlite-store.js";
import { PostgresQueryHistoryStore } from "../history/postgres-store.js";
import { createQueryCacheFromEnv } from "../cache/redis-query-cache.js";
import { TenantRateLimiter } from "../runtime/rate-limit.js";
import { InMemoryExportJobStore } from "../export/csv.js";
import { createDefaultModelRegistry } from "../governance/model-registry.js";
import { createDefaultSloMonitor } from "../runtime/slo.js";
import { createAlertSink } from "../runtime/alert-sink.js";
import { InMemorySlowQueryRecorder } from "../runtime/slow-query.js";
import {
  InMemoryAnalysisFeedbackStore,
  PersistentAnalysisFeedbackStore,
} from "../governance/feedback.js";
import {
  InMemoryAnalysisJobStore,
  PersistentAnalysisJobStore,
} from "../runtime/analysis-jobs.js";
import { createDefaultTelemetry } from "../runtime/telemetry.js";
import { InMemoryMetadataReviewStore } from "../metadata/review.js";
import { DeterministicEmbeddingProvider } from "../metadata/embeddings.js";
import { InMemoryVectorIndexBackend } from "../metadata/vector-backend.js";
import { SchemaIndexer } from "../metadata/indexer.js";
import { emitAuditEvent, setAuditEmitter } from "../audit/events.js";
import { DEMO_SCHEMA_DOCUMENTS, createDemoRetriever } from "../metadata/demo-documents.js";
import { setAuditLogger } from "../audit/logger.js";
import {
  createMetadataStack,
  LazySchemaRetriever,
  shouldUseVectorMetadata,
} from "../metadata/metadata-factory.js";
import { createIndexedVectorRetriever } from "../metadata/vector-schema-retriever.js";
import {
  InMemorySessionStore,
  SqliteCheckpointSaver,
  SqliteSessionStore,
} from "../session/index.js";
import { EnvSecretProvider, TestSecretProvider } from "../datasource/secrets.js";
import { InMemoryDataSourceRegistry } from "../datasource/registry.js";
import { createSqliteDataSourceConfig } from "../datasource/types.js";
import { buildSqliteExecutorRegistry } from "../datasource/executor-factory.js";
import { createDatabase, seedDatabase } from "../db/seed.js";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AuthProvider } from "../config/types.js";
import type { SchemaRetriever } from "../metadata/retriever.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface LocalProfileResources {
  db: Database.Database;
  dbPath: string;
}

export interface LocalRuntimeBundle extends RuntimeProfile {
  resources: LocalProfileResources;
}

function resolveDevDbPath(): string {
  return path.resolve(moduleDir, "../../data/ecommerce.db");
}

function resolveTestDbPath(): string {
  return path.join(
    process.env.TEMP ?? process.env.TMP ?? "/tmp",
    `bi-analyst-test-runtime-${process.pid}.db`,
  );
}

class HeaderAuthProvider implements AuthProvider {
  constructor(private readonly fallback: AuthenticatedPrincipal) {}

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedPrincipal> {
    const subjectId = headerValue(headers, "x-subject-id") ?? this.fallback.subjectId;
    const tenantId = headerValue(headers, "x-tenant-id") ?? this.fallback.tenantId;
    const rolesHeader = headerValue(headers, "x-roles");
    const roles = rolesHeader
      ? rolesHeader.split(",").map((role) => role.trim()).filter(Boolean)
      : this.fallback.roles;

    return {
      subjectId,
      tenantId,
      roles,
      claims: {},
    };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function resolveLocalSchemaRetriever(isTest: boolean): SchemaRetriever {
  if (isTest || !shouldUseVectorMetadata()) {
    return createDemoRetriever();
  }

  if (process.env.QDRANT_URL) {
    const { retriever } = createMetadataStack();
    return retriever;
  }

  return new LazySchemaRetriever(async () => {
    const { retriever } = await createIndexedVectorRetriever(
      DEMO_SCHEMA_DOCUMENTS,
      { collectionAlias: "bi-metadata-local-dev" },
    );
    return retriever;
  });
}

function resolveLocalPolicyProvider(): PolicyProvider {
  const remote = createHttpPolicyProviderFromEnv(process.env);
  if (remote) return remote;
  const policyPath = process.env.POLICY_CONFIG_PATH;
  if (policyPath) {
    return new FilePolicyProvider(policyPath);
  }
  return new InMemoryPolicyProvider([
    {
      ...createDefaultAccessPolicy(
        { subjectId: "*", tenantId: "tenant-1", roles: ["analyst"] },
        ["ecommerce_sqlite"],
      ),
      subjectId: "*",
    },
  ]);
}

export function createLocalRuntimeProfile(
  config: AppConfig,
): LocalRuntimeBundle {
  const isTest = config.environment === "test";
  const dbPath = isTest ? resolveTestDbPath() : resolveDevDbPath();
  const db = createDatabase(dbPath);
  seedDatabase(db);

  // 本地只暴露单一 canonical 数据源，避免重复 id 低置信度选源失败。
  // 指标 YAML / demo 文档统一使用 ecommerce_sqlite。
  const dataSourceId = "ecommerce_sqlite";
  const sourceConfig = createSqliteDataSourceConfig(dataSourceId, dbPath);
  const registry = InMemoryDataSourceRegistry.fromConfigs([sourceConfig]);
  const principal: AuthenticatedPrincipal = {
    tenantId: "tenant-1",
    subjectId: isTest ? "user-test" : "user-dev",
    roles: ["analyst"],
    claims: {},
  };

  const sessionStore = isTest
    ? new InMemorySessionStore()
    : new SqliteSessionStore(db);
  const checkpointer = isTest
    ? new MemorySaver()
    : new SqliteCheckpointSaver(db);
  const policyProvider = resolveLocalPolicyProvider();
  const auditStore = isTest ? new InMemoryAuditStore() : new SqliteAuditStore(db);
  const auditSink = createLocalAuditSink({ store: auditStore });
  setAuditEmitter(auditSink.emitter!);
  setAuditLogger(auditSink.logger);

  const exportSecret = isTest
    ? "test-export-secret-32chars-minimum!!"
    : process.env.EXPORT_ENCRYPTION_SECRET;
  const alertSink = createAlertSink(process.env);
  const schemaIndexer = new SchemaIndexer({
    backend: new InMemoryVectorIndexBackend(),
    embeddings: new DeterministicEmbeddingProvider(),
    collectionAlias: isTest ? "bi-metadata-test" : "bi-metadata-local",
  });
  const executorRegistry = buildSqliteExecutorRegistry({
    db,
    dataSourceId,
    config: sourceConfig,
  });

  return {
    environment: config.environment,
    isLocal: true,
    authProvider: new HeaderAuthProvider(principal),
    secretProvider: isTest
      ? new TestSecretProvider({ TEST_DB_PASSWORD: "unused" })
      : new EnvSecretProvider(),
    dataSourceRegistry: registry,
    schemaRetriever: resolveLocalSchemaRetriever(isTest),
    checkpointer,
    auditSink,
    sessionStore,
    policyProvider,
    executorRegistry,
    productization: {
      historyStore: isTest
        ? new InMemoryQueryHistoryStore()
        : process.env.HISTORY_DATABASE_URL || process.env.AUDIT_DATABASE_URL
          ? new PostgresQueryHistoryStore({
              connectionString:
                process.env.HISTORY_DATABASE_URL ||
                process.env.AUDIT_DATABASE_URL,
            })
          : new SqliteQueryHistoryStore(db),
      queryCache: createQueryCacheFromEnv(process.env),
      rateLimiter: new TenantRateLimiter(120, 60_000),
      exportJobs: new InMemoryExportJobStore(exportSecret),
      modelRegistry: createDefaultModelRegistry(),
      metadataReview: new InMemoryMetadataReviewStore(),
      schemaIndexer,
      slowQueryRecorder: new InMemorySlowQueryRecorder(),
      feedbackStore: isTest
        ? new InMemoryAnalysisFeedbackStore()
        : new PersistentAnalysisFeedbackStore(`${dbPath}.feedback.json`, exportSecret),
      analysisJobs: isTest
        ? new InMemoryAnalysisJobStore()
        : new PersistentAnalysisJobStore(`${dbPath}.analysis-jobs.json`, exportSecret),
      telemetry: createDefaultTelemetry(process.env),
      alertSink,
      sloMonitor: createDefaultSloMonitor((alert) => {
        void alertSink.notify(alert);
        emitAuditEvent({
          event: "slo.alert",
          requestId: "n/a",
          traceId: "n/a",
          subjectId: "system",
          tenantId: "system",
          metadata: {
            kind: alert.kind,
            threshold: alert.threshold,
            actual: alert.actual,
            at: alert.at,
          },
        });
      }),
    },
    resources: { db, dbPath },
  };
}

export function loadPolicyForPrincipal(
  principal: AuthenticatedPrincipal,
  profile: RuntimeProfile,
) {
  const loaded = profile.policyProvider.loadPolicy(principal);
  if (typeof (loaded as { then?: unknown }).then === "function") {
    throw new Error(
      "异步 PolicyProvider 请使用 loadPolicyForPrincipalAsync",
    );
  }
  const base = loaded as import("../policy/access-policy.js").AccessPolicy;
  const authorized = profile.dataSourceRegistry.getAuthorized(principal, base);
  return withAuthorizedDataSources(
    base,
    authorized.map((source) => source.id),
  );
}

export async function loadPolicyForPrincipalAsync(
  principal: AuthenticatedPrincipal,
  profile: RuntimeProfile,
) {
  const base = await profile.policyProvider.loadPolicy(principal);
  const authorized = profile.dataSourceRegistry.getAuthorized(principal, base);
  return withAuthorizedDataSources(
    base,
    authorized.map((source) => source.id),
  );
}
