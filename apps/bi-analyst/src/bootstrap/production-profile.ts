import type { AppConfig } from "../config/types.js";
import type { RuntimeProfile, AuthProvider } from "../config/types.js";
import { ConfigError } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { SecretProvider } from "../datasource/secrets.js";
import {
  createCloudSecretProviderFromEnv,
  createSecretProviderFromEnv,
} from "../datasource/secrets.js";
import { withSecretAudit } from "../datasource/auditing-secret-provider.js";
import type { DataSourceRegistry } from "../datasource/registry.js";
import type { SchemaRetriever, SchemaSearchOptions } from "../metadata/retriever.js";
import type { SchemaDocument } from "../metadata/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import {
  FilePolicyProvider,
  type PolicyProvider,
} from "../policy/policy-provider.js";
import { createHttpPolicyProviderFromEnv } from "../policy/http-policy-provider.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { createMetadataStack } from "../metadata/metadata-factory.js";
import { createFileSessionStore } from "../session/store.js";
import { RedisSessionStore } from "../session/redis-store.js";
import { RespRedisCacheBackend } from "../cache/redis-query-cache.js";
import {
  PostgresCheckpointSaver,
  resolveCheckpointConnectionFromEnv,
} from "../session/postgres-checkpointer.js";
import { loadDataSourceRegistryFromYaml } from "../datasource/registry-loader.js";
import { createJwtAuthProviderFromEnv } from "../auth/jwt-auth-provider.js";
import { createOidcAuthProviderFromEnv } from "../auth/oidc-auth-provider.js";
import { getStagingMockAuth } from "../auth/staging-mock-auth.js";
import { createAuditSinkFromEnv } from "../audit/sink.js";
import { createProductizationFromEnv } from "./productization-factory.js";
import { createExecutorRegistry } from "../datasource/executor-registry.js";

class ProductionAuthProvider implements AuthProvider {
  async authenticate(): Promise<never> {
    throw new AppError(
      "生产环境须配置 JWT/SSO 认证适配器（设置 AUTH_JWKS_URL / AUTH_JWKS_JSON / AUTH_OIDC_DISCOVERY_URL）",
      "config_invalid",
      500,
      false,
    );
  }
}

class ProductionSecretProvider implements SecretProvider {
  async resolve(): Promise<never> {
    throw new AppError(
      "生产环境须配置 Vault/AWS SM/Azure KV SecretProvider（VAULT_ADDR / AWS_REGION+密钥 / AZURE_KEY_VAULT_*）",
      "config_invalid",
      500,
      false,
    );
  }
}

class ProductionRegistry implements DataSourceRegistry {
  get(): undefined {
    return undefined;
  }
  list() {
    return [];
  }
  getAuthorized() {
    return [];
  }
}

class ProductionRetriever implements SchemaRetriever {
  async search(
    _query: string,
    _options: SchemaSearchOptions,
    _policy?: AccessPolicy | null,
  ): Promise<SchemaDocument[]> {
    throw new AppError(
      "生产环境须配置 QDRANT_URL 以启用 SchemaRetriever",
      "config_invalid",
      500,
      false,
    );
  }
}

/** 单机 staging：允许 InMemory 向量回退（需显式 BI_ALLOW_INMEMORY_RETRIEVER=1） */
export function isSingleMachineStaging(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    config.environment === "staging" && env.BI_SINGLE_MACHINE_STAGING === "1"
  );
}

function createProductionSchemaRetriever(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): SchemaRetriever {
  if (env.QDRANT_URL) {
    return createMetadataStack({
      qdrantUrl: env.QDRANT_URL,
      qdrantApiKey: env.QDRANT_API_KEY,
    }).retriever;
  }
  if (
    isSingleMachineStaging(config, env) &&
    env.BI_ALLOW_INMEMORY_RETRIEVER === "1"
  ) {
    return createMetadataStack({}).retriever;
  }
  return new ProductionRetriever();
}

class ProductionCheckpointer {
  async getTuple() {
    return undefined;
  }
  async put() {
    throw new AppError(
      "生产环境须配置持久化 checkpointer（设置 CHECKPOINT_DATABASE_URL 或 AUDIT_DATABASE_URL）",
      "config_invalid",
      500,
      false,
    );
  }
  async putWrites() {}
  async *list() {}
}

function createProductionSecretProvider(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): SecretProvider {
  const cloud = createCloudSecretProviderFromEnv(env);
  const allowEnv =
    env.BI_ALLOW_ENV_SECRETS === "1" || isSingleMachineStaging(config, env);
  const base =
    cloud ??
    (allowEnv ? createSecretProviderFromEnv(env) : new ProductionSecretProvider());
  if (env.BI_SECRET_AUDIT === "0") return base;
  return withSecretAudit(base);
}

function createProductionCheckpointer(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): BaseCheckpointSaver {
  if (
    env.CHECKPOINT_DATABASE_URL ||
    env.HISTORY_DATABASE_URL ||
    env.AUDIT_DATABASE_URL
  ) {
    return new PostgresCheckpointSaver({
      connectionString: resolveCheckpointConnectionFromEnv(env),
    });
  }
  if (isSingleMachineStaging(config, env)) {
    return new MemorySaver();
  }
  return new ProductionCheckpointer() as unknown as BaseCheckpointSaver;
}

function createProductionAuthProvider(
  env: NodeJS.ProcessEnv,
  sessionStore: RuntimeProfile["sessionStore"],
): AuthProvider {
  const mock = getStagingMockAuth();
  if (mock) return mock.provider;

  const oidc = createOidcAuthProviderFromEnv(env, sessionStore);
  if (oidc) return oidc;

  return createJwtAuthProviderFromEnv(env) ?? new ProductionAuthProvider();
}

function hasAuthConfig(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AUTH_JWKS_URL?.trim() ||
      env.AUTH_JWKS_JSON?.trim() ||
      env.AUTH_OIDC_DISCOVERY_URL?.trim() ||
      getStagingMockAuth(),
  );
}

function collectMissingProductionKeys(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const missing: string[] = [];
  if (!env.DATASOURCE_REGISTRY_PATH) missing.push("DATASOURCE_REGISTRY_PATH");
  if (!env.POLICY_CONFIG_PATH && !env.POLICY_SERVICE_URL) {
    missing.push("POLICY_CONFIG_PATH|POLICY_SERVICE_URL");
  }

  const single = isSingleMachineStaging(config, env);
  if (!env.QDRANT_URL) {
    if (!(single && env.BI_ALLOW_INMEMORY_RETRIEVER === "1")) {
      missing.push(
        single
          ? "QDRANT_URL|BI_ALLOW_INMEMORY_RETRIEVER=1"
          : "QDRANT_URL",
      );
    }
  }
  if (!hasAuthConfig(env)) {
    missing.push(
      single
        ? "AUTH_JWKS_URL|AUTH_JWKS_JSON|AUTH_OIDC_DISCOVERY_URL|BI_STAGING_MOCK_AUTH"
        : "AUTH_JWKS_URL|AUTH_JWKS_JSON|AUTH_OIDC_DISCOVERY_URL",
    );
  }
  if (!env.AUTH_ISSUER?.trim()) missing.push("AUTH_ISSUER");
  if (!env.AUTH_AUDIENCE?.trim()) missing.push("AUTH_AUDIENCE");
  if (config.environment === "production") {
    if (!env.REDIS_URL?.trim()) missing.push("REDIS_URL");
    if ((env.EXPORT_ENCRYPTION_SECRET?.length ?? 0) < 32) {
      missing.push("EXPORT_ENCRYPTION_SECRET(32+ chars)");
    }
  }
  if (
    config.environment === "production" &&
    (env.HISTORY_ENCRYPTION_SECRET?.length ?? 0) < 32
  ) {
    missing.push("HISTORY_ENCRYPTION_SECRET(32+ chars)");
  }
  if (
    config.environment === "production" &&
    !env.HISTORY_DATABASE_URL?.trim() &&
    !env.AUDIT_DATABASE_URL?.trim()
  ) {
    missing.push("HISTORY_DATABASE_URL|AUDIT_DATABASE_URL");
  }
  if (
    config.environment === "staging" &&
    env.BI_STAGING_MOCK_AUTH === "1" &&
    (env.BI_STAGING_MOCK_ADMIN_KEY?.length ?? 0) < 24
  ) {
    missing.push("BI_STAGING_MOCK_ADMIN_KEY(24+ chars)");
  }
  if (!env.AUDIT_DATABASE_URL && !single) {
    // 生产强制持久化审计；单机 staging 可用内存/本地 sink
  }
  return missing;
}

/** staging/production 必须显式注入外部依赖；单机 staging 允许受控回退 */
export function createProductionRuntimeProfile(
  config: AppConfig,
  overrides: Partial<RuntimeProfile> = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProfile {
  if (config.environment === "production" && env.BI_STAGING_MOCK_AUTH === "1") {
    throw new ConfigError("BI_STAGING_MOCK_AUTH must never be enabled in production");
  }
  if (
    config.environment === "staging" &&
    env.BI_STAGING_MOCK_AUTH === "1" &&
    (env.BI_STAGING_MOCK_ADMIN_KEY?.length ?? 0) < 24
  ) {
    throw new ConfigError(
      "BI_STAGING_MOCK_ADMIN_KEY must contain at least 24 characters",
    );
  }
  const missing = collectMissingProductionKeys(config, env);
  if (missing.length > 0 && Object.keys(overrides).length === 0) {
    throw new ConfigError(
      `生产 Profile 缺少必需配置: ${missing.join(", ")}。禁止回退到本地 SQLite/内存检索/测试身份。`,
    );
  }

  const stateRoot = env.STATE_VOLUME_PATH?.trim() || "./data";
  const single = isSingleMachineStaging(config, env);
  const sessionStore =
    overrides.sessionStore ??
    (config.environment === "production"
      ? new RedisSessionStore(
          new RespRedisCacheBackend(env.REDIS_URL ?? ""),
        )
      : createFileSessionStore(
          env.SESSION_DATABASE_PATH ?? `${stateRoot}/production-sessions.db`,
        ));

  const auditSink =
    overrides.auditSink ??
    (env.AUDIT_DATABASE_URL || single
      ? createAuditSinkFromEnv(env)
      : {
          logger: {
            log() {
              throw new AppError(
                "生产环境须配置持久化 AuditSink（设置 AUDIT_DATABASE_URL）",
                "config_invalid",
                500,
                false,
              );
            },
          },
        });

  return {
    environment: config.environment,
    isLocal: false,
    authProvider:
      overrides.authProvider ??
      createProductionAuthProvider(env, sessionStore),
    secretProvider:
      overrides.secretProvider ?? createProductionSecretProvider(config, env),
    dataSourceRegistry:
      overrides.dataSourceRegistry ?? createProductionRegistry(env),
    schemaRetriever:
      overrides.schemaRetriever ??
      createProductionSchemaRetriever(config, env),
    checkpointer:
      overrides.checkpointer ?? createProductionCheckpointer(config, env),
    auditSink,
    sessionStore,
    policyProvider:
      overrides.policyProvider ?? createProductionPolicyProvider(env),
    productization:
      overrides.productization ?? createProductizationFromEnv(env, config),
    /** 空 Registry，供 attachLiveDataSources / 外部注入填充 */
    executorRegistry: overrides.executorRegistry ?? createExecutorRegistry([]),
    ...overrides,
  };
}

function createProductionPolicyProvider(
  env: NodeJS.ProcessEnv,
): PolicyProvider {
  const remote = createHttpPolicyProviderFromEnv(env);
  if (remote) return remote;

  const policyPath = env.POLICY_CONFIG_PATH;
  if (!policyPath) {
    return {
      loadPolicy() {
        throw new AppError(
          "生产环境须配置 POLICY_SERVICE_URL 或 POLICY_CONFIG_PATH 策略源",
          "config_invalid",
          500,
          false,
        );
      },
    };
  }
  return new FilePolicyProvider(policyPath);
}

function createProductionRegistry(
  env: NodeJS.ProcessEnv,
): DataSourceRegistry {
  const registryPath = env.DATASOURCE_REGISTRY_PATH;
  if (!registryPath) {
    return new ProductionRegistry();
  }
  try {
    return loadDataSourceRegistryFromYaml(registryPath, env);
  } catch (err) {
    throw new ConfigError(
      `无法加载数据源注册表 ${registryPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
