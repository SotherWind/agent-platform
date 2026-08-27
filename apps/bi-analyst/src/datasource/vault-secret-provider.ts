import { AppError } from "../errors/app-error.js";
import type { ResolvedSecret, SecretReference } from "./types.js";
import type { SecretProvider } from "./secrets.js";

export interface VaultSecretProviderOptions {
  /** Vault 地址，如 https://vault.example.com:8200 */
  address: string;
  /** 静态 token；与 AppRole 二选一 */
  token?: string;
  /** AppRole role_id */
  roleId?: string;
  /** AppRole secret_id */
  secretId?: string;
  /** KV v2 mount 路径，默认 secret */
  kvMount?: string;
  /** 可选：覆盖 fetch（单测注入） */
  fetchImpl?: typeof fetch;
  /** token 缓存刷新提前量（毫秒） */
  tokenSkewMs?: number;
}

interface VaultTokenState {
  token: string;
  expiresAt: number;
}

/**
 * HashiCorp Vault KV v2 SecretProvider。
 * SecretReference.key 为 mount 下的逻辑路径（不含 /data/），如 `bi/mysql/password`。
 * 若密钥对象含多个字段，默认取 `value` / `password` / 首个 string 字段。
 */
export class VaultSecretProvider implements SecretProvider {
  private readonly address: string;
  private readonly kvMount: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenSkewMs: number;
  private readonly staticToken?: string;
  private readonly roleId?: string;
  private readonly secretId?: string;
  private tokenState: VaultTokenState | null = null;

  constructor(options: VaultSecretProviderOptions) {
    if (!options.address) {
      throw new Error("VaultSecretProvider 需要 address");
    }
    if (!options.token && !(options.roleId && options.secretId)) {
      throw new Error("VaultSecretProvider 需要 token 或 AppRole (roleId+secretId)");
    }
    this.address = options.address.replace(/\/$/, "");
    this.kvMount = (options.kvMount ?? "secret").replace(/^\/|\/$/g, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenSkewMs = options.tokenSkewMs ?? 30_000;
    this.staticToken = options.token;
    this.roleId = options.roleId;
    this.secretId = options.secretId;
    if (options.token) {
      this.tokenState = { token: options.token, expiresAt: Number.POSITIVE_INFINITY };
    }
  }

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    if (ref.provider !== "vault") {
      throw new AppError(
        `VaultSecretProvider 仅支持 vault provider，收到: ${ref.provider}`,
        "config_invalid",
        500,
        false,
      );
    }
    const token = await this.resolveToken();
    const path = ref.key.replace(/^\/+/, "");
    const versionQuery = ref.version ? `?version=${encodeURIComponent(ref.version)}` : "";
    const url = `${this.address}/v1/${this.kvMount}/data/${path}${versionQuery}`;

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "X-Vault-Token": token,
        Accept: "application/json",
      },
    });

    if (response.status === 404) {
      throw new AppError(`Vault 密钥不存在: ${path}`, "config_invalid", 500, false);
    }
    if (!response.ok) {
      throw new AppError(
        `Vault 读取失败 (${response.status}): ${path}`,
        "config_invalid",
        500,
        false,
      );
    }

    const body = (await response.json()) as {
      data?: { data?: Record<string, unknown>; metadata?: { version?: number } };
    };
    const data = body.data?.data;
    if (!data || typeof data !== "object") {
      throw new AppError(`Vault 密钥格式无效: ${path}`, "config_invalid", 500, false);
    }

    const value = pickSecretValue(data);
    if (value === undefined) {
      throw new AppError(`Vault 密钥无可用字段: ${path}`, "config_invalid", 500, false);
    }
    return { value };
  }

  private async resolveToken(): Promise<string> {
    if (this.staticToken) return this.staticToken;
    if (
      this.tokenState &&
      this.tokenState.expiresAt - this.tokenSkewMs > Date.now()
    ) {
      return this.tokenState.token;
    }
    return this.loginAppRole();
  }

  private async loginAppRole(): Promise<string> {
    const url = `${this.address}/v1/auth/approle/login`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        role_id: this.roleId,
        secret_id: this.secretId,
      }),
    });
    if (!response.ok) {
      throw new AppError(
        `Vault AppRole 登录失败 (${response.status})`,
        "config_invalid",
        500,
        false,
      );
    }
    const body = (await response.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    const token = body.auth?.client_token;
    if (!token) {
      throw new AppError("Vault AppRole 未返回 client_token", "config_invalid", 500, false);
    }
    const leaseSec = body.auth?.lease_duration ?? 3600;
    this.tokenState = {
      token,
      expiresAt: Date.now() + leaseSec * 1000,
    };
    return token;
  }
}

function pickSecretValue(data: Record<string, unknown>): string | undefined {
  for (const key of ["value", "password", "secret", "token"]) {
    const v = data[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const v of Object.values(data)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** 从环境变量装配 VaultSecretProvider；缺配置返回 null */
export function createVaultSecretProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): VaultSecretProvider | null {
  const address = env.VAULT_ADDR?.trim();
  if (!address) return null;

  const token = env.VAULT_TOKEN?.trim();
  const roleId = env.VAULT_ROLE_ID?.trim();
  const secretId = env.VAULT_SECRET_ID?.trim();
  if (!token && !(roleId && secretId)) return null;

  return new VaultSecretProvider({
    address,
    token: token || undefined,
    roleId: roleId || undefined,
    secretId: secretId || undefined,
    kvMount: env.VAULT_KV_MOUNT?.trim() || "secret",
    fetchImpl,
  });
}
