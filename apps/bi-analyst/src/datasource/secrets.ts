import type { ResolvedSecret, SecretReference } from "./types.js";
import { createVaultSecretProviderFromEnv } from "./vault-secret-provider.js";
import { createAwsSecretsManagerProviderFromEnv } from "./aws-secret-provider.js";
import { createAzureKeyVaultProviderFromEnv } from "./azure-secret-provider.js";
import { AppError } from "../errors/app-error.js";

export interface SecretProvider {
  resolve(ref: SecretReference): Promise<ResolvedSecret>;
}

/** 本地开发 / 测试：从环境变量读取密钥 */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    if (ref.provider !== "env" && ref.provider !== "test") {
      throw new Error(
        `EnvSecretProvider 仅支持 env/test provider，收到: ${ref.provider}`,
      );
    }
    const value = this.env[ref.key];
    if (value === undefined) {
      throw new Error(`环境变量 ${ref.key} 未设置`);
    }
    return { value };
  }
}

/** 测试用：固定返回值 */
export class TestSecretProvider implements SecretProvider {
  constructor(private readonly secrets: Record<string, string>) {}

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    const value = this.secrets[ref.key];
    if (value === undefined) {
      throw new Error(`测试密钥 ${ref.key} 未配置`);
    }
    return { value };
  }
}

/**
 * 按 SecretReference.provider 路由到对应实现。
 * 生产装配：Vault / AWS SM / Azure KV 可并存。
 */
export class CompositeSecretProvider implements SecretProvider {
  constructor(
    private readonly providers: Partial<
      Record<SecretReference["provider"], SecretProvider>
    >,
  ) {}

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    const provider = this.providers[ref.provider];
    if (!provider) {
      throw new AppError(
        `未装配 SecretProvider: ${ref.provider}`,
        "config_invalid",
        500,
        false,
      );
    }
    return provider.resolve(ref);
  }

  has(provider: SecretReference["provider"]): boolean {
    return Boolean(this.providers[provider]);
  }

  configuredProviders(): SecretReference["provider"][] {
    return (Object.keys(this.providers) as SecretReference["provider"][]).filter(
      (k) => this.providers[k],
    );
  }
}

/**
 * 按环境装配 SecretProvider：
 * - Vault / AWS SM / Azure KV（可组合）
 * - 否则 EnvSecretProvider（本地）
 */
export function createSecretProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecretProvider {
  const cloud = createCloudSecretProviderFromEnv(env);
  if (cloud) return cloud;
  return new EnvSecretProvider(env);
}

/**
 * 生产 Profile 用：优先返回已配置的云密钥提供方；全无则 null（由调用方 fail closed）。
 */
export function createCloudSecretProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecretProvider | null {
  const vault = createVaultSecretProviderFromEnv(env);
  const aws = createAwsSecretsManagerProviderFromEnv(env);
  const azure = createAzureKeyVaultProviderFromEnv(env);
  if (!vault && !aws && !azure) return null;

  const map: Partial<Record<SecretReference["provider"], SecretProvider>> = {};
  if (vault) map.vault = vault;
  if (aws) map["aws-sm"] = aws;
  if (azure) map["azure-kv"] = azure;
  if (env.BI_ALLOW_ENV_SECRETS === "1") {
    map.env = new EnvSecretProvider(env);
  }

  const cloudKeys = (["vault", "aws-sm", "azure-kv"] as const).filter(
    (k) => map[k],
  );
  if (cloudKeys.length === 1 && !map.env) {
    return map[cloudKeys[0]!]!;
  }
  return new CompositeSecretProvider(map);
}

let defaultProvider: SecretProvider = new EnvSecretProvider();

export function getSecretProvider(): SecretProvider {
  return defaultProvider;
}

export function setSecretProvider(provider: SecretProvider): void {
  defaultProvider = provider;
}

export async function resolveSecret(
  ref: SecretReference,
): Promise<ResolvedSecret> {
  return getSecretProvider().resolve(ref);
}

export { AuditingSecretProvider, withSecretAudit } from "./auditing-secret-provider.js";
