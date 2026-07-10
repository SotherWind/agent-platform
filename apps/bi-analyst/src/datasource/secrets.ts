import type { ResolvedSecret, SecretReference } from "./types.js";

export interface SecretProvider {
  resolve(ref: SecretReference): Promise<ResolvedSecret>;
}

/** 本地开发 / 测试：从环境变量读取密钥 */
export class EnvSecretProvider implements SecretProvider {
  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    if (ref.provider !== "env" && ref.provider !== "test") {
      throw new Error(
        `EnvSecretProvider 仅支持 env/test provider，收到: ${ref.provider}`,
      );
    }
    const value = process.env[ref.key];
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
