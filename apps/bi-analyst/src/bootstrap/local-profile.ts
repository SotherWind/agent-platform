import { MemorySaver } from "@langchain/langgraph";
import type Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/types.js";
import type { RuntimeProfile } from "../config/types.js";
import { createDefaultAccessPolicy } from "../policy/access-policy.js";
import { createTestPrincipal } from "../auth/principal.js";
import { ConsoleAuditLogger } from "../audit/logger.js";
import { DEMO_SCHEMA_DOCUMENTS, createDemoRetriever } from "../metadata/demo-documents.js";
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

export function createLocalRuntimeProfile(
  config: AppConfig,
): LocalRuntimeBundle {
  const isTest = config.environment === "test";
  const dbPath = isTest ? resolveTestDbPath() : resolveDevDbPath();
  const db = createDatabase(dbPath);
  seedDatabase(db);

  const dataSourceId = isTest ? "test" : "ecommerce_sqlite";
  const sourceConfig = createSqliteDataSourceConfig(dataSourceId, dbPath);
  const registry = InMemoryDataSourceRegistry.fromConfigs([sourceConfig]);
  const principal = createTestPrincipal({
    tenantId: "tenant-1",
    subjectId: isTest ? "user-test" : "user-dev",
  });
  const allowedIds = [dataSourceId, "default", "ecommerce_sqlite", "test"];

  const sessionStore = isTest
    ? new InMemorySessionStore()
    : new SqliteSessionStore(db);
  const checkpointer = isTest
    ? new MemorySaver()
    : new SqliteCheckpointSaver(db);

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
    auditSink: { logger: new ConsoleAuditLogger() },
    sessionStore,
    resources: { db, dbPath },
  };
}

export function loadPolicyForPrincipal(
  principal: AuthenticatedPrincipal,
  profile: RuntimeProfile,
) {
  const authorized = profile.dataSourceRegistry.getAuthorized(
    principal,
    createDefaultAccessPolicy(principal),
  );
  return createDefaultAccessPolicy(
    principal,
    authorized.map((source) => source.id),
  );
}
