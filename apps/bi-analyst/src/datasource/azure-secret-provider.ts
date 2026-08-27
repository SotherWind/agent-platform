import { AppError } from "../errors/app-error.js";
import type { ResolvedSecret, SecretReference } from "./types.js";
import type { SecretProvider } from "./secrets.js";

export interface AzureKeyVaultProviderOptions {
  /** Key Vault 名称，如 my-vault → https://my-vault.vault.azure.net */
  vaultName: string;
  /** 或完整 vault URI（优先） */
  vaultUrl?: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /** token 刷新提前量 */
  tokenSkewMs?: number;
}

interface TokenState {
  token: string;
  expiresAt: number;
}

/**
 * Azure Key Vault SecretProvider（OAuth2 client credentials + Secrets REST）。
 * SecretReference.key 为密钥名称；version 可选。
 */
export class AzureKeyVaultProvider implements SecretProvider {
  private readonly vaultUrl: string;
  private readonly tenantId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenSkewMs: number;
  private tokenState: TokenState | null = null;

  constructor(options: AzureKeyVaultProviderOptions) {
    const vaultUrl =
      options.vaultUrl?.replace(/\/$/, "") ||
      (options.vaultName
        ? `https://${options.vaultName}.vault.azure.net`
        : "");
    if (!vaultUrl) {
      throw new Error("AzureKeyVaultProvider 需要 vaultName 或 vaultUrl");
    }
    if (!options.tenantId || !options.clientId || !options.clientSecret) {
      throw new Error(
        "AzureKeyVaultProvider 需要 tenantId / clientId / clientSecret",
      );
    }
    this.vaultUrl = vaultUrl;
    this.tenantId = options.tenantId;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenSkewMs = options.tokenSkewMs ?? 30_000;
  }

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    if (ref.provider !== "azure-kv") {
      throw new AppError(
        `AzureKeyVaultProvider 仅支持 azure-kv provider，收到: ${ref.provider}`,
        "config_invalid",
        500,
        false,
      );
    }

    const token = await this.resolveToken();
    const name = encodeURIComponent(ref.key.replace(/^\/+/, ""));
    const version = ref.version
      ? `/${encodeURIComponent(ref.version)}`
      : "";
    const url = `${this.vaultUrl}/secrets/${name}${version}?api-version=7.4`;

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.status === 404) {
      throw new AppError(
        `Azure Key Vault 密钥不存在: ${ref.key}`,
        "config_invalid",
        500,
        false,
      );
    }
    if (!response.ok) {
      throw new AppError(
        `Azure Key Vault 读取失败 (${response.status}): ${ref.key}`,
        "config_invalid",
        500,
        false,
      );
    }

    const body = (await response.json()) as { value?: string };
    if (!body.value) {
      throw new AppError(
        `Azure Key Vault 密钥为空: ${ref.key}`,
        "config_invalid",
        500,
        false,
      );
    }
    return { value: pickJsonOrRaw(body.value) };
  }

  private async resolveToken(): Promise<string> {
    if (
      this.tokenState &&
      this.tokenState.expiresAt - this.tokenSkewMs > Date.now()
    ) {
      return this.tokenState.token;
    }
    return this.loginClientCredentials();
  }

  private async loginClientCredentials(): Promise<string> {
    const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://vault.azure.net/.default",
    });

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (!response.ok) {
      throw new AppError(
        `Azure AD 登录失败 (${response.status})`,
        "config_invalid",
        500,
        false,
      );
    }

    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new AppError(
        "Azure AD 未返回 access_token",
        "config_invalid",
        500,
        false,
      );
    }
    const expiresIn = body.expires_in ?? 3600;
    this.tokenState = {
      token: body.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return body.access_token;
  }
}

function pickJsonOrRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["value", "password", "secret", "token"]) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
      for (const v of Object.values(obj)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
    } catch {
      /* keep raw */
    }
  }
  return raw;
}

/** 从环境变量装配；缺配置返回 null */
export function createAzureKeyVaultProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): AzureKeyVaultProvider | null {
  const vaultName = env.AZURE_KEY_VAULT_NAME?.trim();
  const vaultUrl = env.AZURE_KEY_VAULT_URL?.trim();
  const tenantId = env.AZURE_TENANT_ID?.trim();
  const clientId = env.AZURE_CLIENT_ID?.trim();
  const clientSecret = env.AZURE_CLIENT_SECRET?.trim();
  if ((!vaultName && !vaultUrl) || !tenantId || !clientId || !clientSecret) {
    return null;
  }

  return new AzureKeyVaultProvider({
    vaultName: vaultName ?? "",
    vaultUrl,
    tenantId,
    clientId,
    clientSecret,
    fetchImpl,
  });
}
