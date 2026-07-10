import type { AppConfig } from "../config/types.js";
import type { RuntimeProfile, AuthProvider } from "../config/types.js";
import { ConfigError } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { SecretProvider } from "../datasource/secrets.js";
import type { DataSourceRegistry } from "../datasource/registry.js";
import type { SchemaRetriever, SchemaSearchOptions } from "../metadata/retriever.js";
import type { SchemaDocument } from "../metadata/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createMetadataStack } from "../metadata/metadata-factory.js";
import { InMemorySessionStore } from "../session/store.js";

class ProductionAuthProvider implements AuthProvider {
  async authenticate(): Promise<never> {
    throw new AppError(
      "生产环境须配置 JWT/SSO 认证适配器",
      "config_invalid",
      500,
      false,
    );
  }
}

class ProductionSecretProvider implements SecretProvider {
  async resolve(): Promise<never> {
    throw new AppError(
      "生产环境须配置 Vault/KMS SecretProvider",
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

function createProductionSchemaRetriever(
  env: NodeJS.ProcessEnv = process.env,
): SchemaRetriever {
  if (!env.QDRANT_URL) {
    return new ProductionRetriever();
  }
  return createMetadataStack({ qdrantUrl: env.QDRANT_URL, qdrantApiKey: env.QDRANT_API_KEY }).retriever;
}

class ProductionCheckpointer {
  async getTuple() {
    return undefined;
  }
  async put() {
    throw new AppError(
      "生产环境须配置持久化 checkpointer",
      "config_invalid",
      500,
      false,
    );
  }
  async putWrites() {}
  async *list() {}
}

/** staging/production 必须显式注入外部依赖；此处 fail closed，禁止 demo fallback */
export function createProductionRuntimeProfile(
  config: AppConfig,
  overrides: Partial<RuntimeProfile> = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProfile {
  const requiredKeys = [
    "DATASOURCE_REGISTRY_PATH",
    "QDRANT_URL",
    "AUTH_JWKS_URL",
  ] as const;

  const missing = requiredKeys.filter((key) => !env[key]);
  if (missing.length > 0 && Object.keys(overrides).length === 0) {
    throw new ConfigError(
      `生产 Profile 缺少必需配置: ${missing.join(", ")}。禁止回退到本地 SQLite/内存检索/测试身份。`,
    );
  }

  return {
    environment: config.environment,
    isLocal: false,
    authProvider: overrides.authProvider ?? new ProductionAuthProvider(),
    secretProvider: overrides.secretProvider ?? new ProductionSecretProvider(),
    dataSourceRegistry:
      overrides.dataSourceRegistry ?? new ProductionRegistry(),
    schemaRetriever: overrides.schemaRetriever ?? createProductionSchemaRetriever(env),
    checkpointer:
      overrides.checkpointer ??
      (new ProductionCheckpointer() as unknown as BaseCheckpointSaver),
    auditSink: overrides.auditSink ?? {
      logger: {
        log() {
          throw new AppError(
            "生产环境须配置持久化 AuditSink",
            "config_invalid",
            500,
            false,
          );
        },
      },
    },
    sessionStore: overrides.sessionStore ?? new InMemorySessionStore(),
    ...overrides,
  };
}
