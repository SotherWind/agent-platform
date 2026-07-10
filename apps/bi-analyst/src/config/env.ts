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
  CONFIG_VERSION: z.string().default("1"),
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

  const { APP_ENV, PORT, MAX_RETRY_COUNT, REQUEST_TIMEOUT_MS, CONFIG_VERSION } =
    parsed.data;

  return {
    environment: APP_ENV,
    port: PORT,
    maxRetryCount: MAX_RETRY_COUNT,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    configVersion: CONFIG_VERSION,
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
    configVersion: config.configVersion,
  };
}
