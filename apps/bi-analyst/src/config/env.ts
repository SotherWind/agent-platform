import { z } from "zod";
import { APP_ENVIRONMENTS, type AppConfig, type AppEnvironment } from "./types.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

const appConfigSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS, {
    error: () => ({
      message:
        "APP_ENV 必须显式设置为 development | test | staging | production",
    }),
  }),
  PORT: z.coerce.number().int().positive().default(3000),
  MAX_RETRY_COUNT: z.coerce.number().int().min(0).max(10).default(3),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
  REQUEST_BODY_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  CONFIG_VERSION: z.string().default("1"),
  DATASOURCE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  TENANT_CONCURRENCY_MAX: z.coerce.number().int().min(1).max(100).default(8),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
  QUERY_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(256),
  QUERY_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().min(1).max(3_600_000).default(1_000),
});

export function parseAppEnvironment(value: unknown): AppEnvironment {
  const parsed = z.enum(APP_ENVIRONMENTS).safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      `无效的 APP_ENV: ${String(value)}。允许值: ${APP_ENVIRONMENTS.join(", ")}`,
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

export function isLocalEnvironment(env: AppEnvironment): boolean {
  return env === "development" || env === "test";
}

/** 启动时一次性 Zod 校验环境配置 */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = appConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      "应用配置校验失败",
      parsed.error.flatten(),
    );
  }

  const {
    APP_ENV,
    PORT,
    MAX_RETRY_COUNT,
    REQUEST_TIMEOUT_MS,
    MAX_REQUEST_BODY_BYTES,
    REQUEST_BODY_TIMEOUT_MS,
    CONFIG_VERSION,
    DATASOURCE_POOL_MAX,
    TENANT_CONCURRENCY_MAX,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
    QUERY_CACHE_MAX_ENTRIES,
    QUERY_CACHE_TTL_MS,
    SLOW_QUERY_THRESHOLD_MS,
  } = parsed.data;

  return {
    environment: APP_ENV,
    port: PORT,
    maxRetryCount: MAX_RETRY_COUNT,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    requestBodyTimeoutMs: REQUEST_BODY_TIMEOUT_MS,
    configVersion: CONFIG_VERSION,
    deployment: {
      datasourcePoolMax: DATASOURCE_POOL_MAX,
      tenantConcurrencyMax: TENANT_CONCURRENCY_MAX,
      rateLimitMax: RATE_LIMIT_MAX,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      queryCacheMaxEntries: QUERY_CACHE_MAX_ENTRIES,
      queryCacheTtlMs: QUERY_CACHE_TTL_MS,
      slowQueryThresholdMs: SLOW_QUERY_THRESHOLD_MS,
    },
  };
}

/** 不含密钥的配置摘要，供启动日志使用 */
export function summarizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    isLocal: isLocalEnvironment(config.environment),
    port: config.port,
    maxRetryCount: config.maxRetryCount,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    requestBodyTimeoutMs: config.requestBodyTimeoutMs,
    configVersion: config.configVersion,
    deployment: config.deployment,
  };
}
