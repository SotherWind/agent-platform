import type { AuthenticatedPrincipal } from "./types.js";
import { AuthError, assertSessionOwnership } from "./principal.js";
import type { AuthProvider } from "../config/types.js";
import type { SessionStore } from "../session/store.js";
import { getSessionAsync } from "../session/store.js";
import {
  JwtAuthProvider,
  parseJwtAlgorithmList,
} from "./jwt-auth-provider.js";

export interface OidcDiscoveryDocument {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  [key: string]: unknown;
}

export interface OidcAuthProviderOptions {
  /** OpenID Provider Issuer 或完整 discovery URL */
  discoveryUrl: string;
  audience?: string | string[];
  issuer?: string;
  algorithms?: string[];
  jwksTimeoutMs?: number;
  jwksCacheTtlMs?: number;
  jwksCooldownMs?: number;
  /** 会话绑定（可选；有则 validateSession 校验归属） */
  sessionStore?: SessionStore;
  /** 测试注入：跳过网络 discovery */
  discoveryDocument?: OidcDiscoveryDocument;
  /** 测试注入：内联 JWKS */
  jwks?: { keys: import("jose").JWK[] };
  fetchImpl?: typeof fetch;
}

/**
 * OIDC 发现 + JWT/JWKS 验签 + 可选会话绑定。
 * 生产可指向真实 IdP；单机可用 discovery mock。
 */
export class OidcAuthProvider implements AuthProvider {
  private readonly discoveryUrl: string;
  private readonly audience?: string | string[];
  private readonly issuerOverride?: string;
  private readonly algorithms?: string[];
  private readonly jwksTimeoutMs?: number;
  private readonly jwksCacheTtlMs?: number;
  private readonly jwksCooldownMs?: number;
  private readonly sessionStore?: SessionStore;
  private readonly fetchImpl: typeof fetch;
  private discovery: OidcDiscoveryDocument | null;
  private jwtProvider: JwtAuthProvider | null = null;

  constructor(options: OidcAuthProviderOptions) {
    this.discoveryUrl = options.discoveryUrl;
    this.audience = options.audience;
    this.issuerOverride = options.issuer;
    this.algorithms = options.algorithms;
    this.jwksTimeoutMs = options.jwksTimeoutMs;
    this.jwksCacheTtlMs = options.jwksCacheTtlMs;
    this.jwksCooldownMs = options.jwksCooldownMs;
    this.sessionStore = options.sessionStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.discovery = options.discoveryDocument ?? null;
    if (options.jwks) {
      this.jwtProvider = new JwtAuthProvider({
        jwks: options.jwks,
        issuer: options.issuer ?? options.discoveryDocument?.issuer,
        audience: options.audience,
        algorithms: this.algorithms,
        jwksTimeoutMs: this.jwksTimeoutMs,
        jwksCacheTtlMs: this.jwksCacheTtlMs,
        jwksCooldownMs: this.jwksCooldownMs,
      });
    }
  }

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedPrincipal> {
    const jwt = await this.resolveJwtProvider();
    return jwt.authenticate(headers);
  }

  /**
   * 会话绑定：确保 sessionId 归属当前 principal（首次自动注册）。
   */
  async validateSession(
    principal: AuthenticatedPrincipal,
    sessionId: string,
  ): Promise<void> {
    if (!this.sessionStore) return;
    const existing = await getSessionAsync(
      this.sessionStore,
      principal.tenantId,
      principal.subjectId,
      sessionId,
    );
    if (existing) {
      assertSessionOwnership(principal, existing);
      return;
    }
    // The API server registers first use with the policy version it loaded.
  }

  async getDiscovery(): Promise<OidcDiscoveryDocument> {
    if (this.discovery) return this.discovery;
    const url = normalizeDiscoveryUrl(this.discoveryUrl);
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new AuthError(
        `OIDC discovery 失败: HTTP ${res.status}`,
        "unauthenticated",
      );
    }
    const body = (await res.json()) as OidcDiscoveryDocument;
    if (!body.issuer || !body.jwks_uri) {
      throw new AuthError(
        "OIDC discovery 缺少 issuer 或 jwks_uri",
        "unauthenticated",
      );
    }
    this.discovery = body;
    return body;
  }

  private async resolveJwtProvider(): Promise<JwtAuthProvider> {
    if (this.jwtProvider) return this.jwtProvider;
    const doc = await this.getDiscovery();
    this.jwtProvider = new JwtAuthProvider({
      jwksUrl: doc.jwks_uri,
      issuer: this.issuerOverride ?? doc.issuer,
      audience: this.audience,
      algorithms: this.algorithms,
      jwksTimeoutMs: this.jwksTimeoutMs,
      jwksCacheTtlMs: this.jwksCacheTtlMs,
      jwksCooldownMs: this.jwksCooldownMs,
    });
    return this.jwtProvider;
  }
}

export function normalizeDiscoveryUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.includes("/.well-known/openid-configuration")) {
    return trimmed;
  }
  return `${trimmed}/.well-known/openid-configuration`;
}

/** 从环境变量装配 OIDC；缺 AUTH_OIDC_DISCOVERY_URL 返回 null */
export function createOidcAuthProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  sessionStore?: SessionStore,
): OidcAuthProvider | null {
  const discoveryUrl = env.AUTH_OIDC_DISCOVERY_URL?.trim();
  if (!discoveryUrl) return null;
  return new OidcAuthProvider({
    discoveryUrl,
    issuer: env.AUTH_ISSUER?.trim() || undefined,
    audience: env.AUTH_AUDIENCE?.trim() || undefined,
    algorithms: parseJwtAlgorithmList(env.AUTH_ALLOWED_ALGORITHMS),
    jwksTimeoutMs: readPositiveInteger(env.AUTH_JWKS_TIMEOUT_MS, 5_000),
    jwksCacheTtlMs: readPositiveInteger(env.AUTH_JWKS_CACHE_TTL_MS, 600_000),
    jwksCooldownMs: readPositiveInteger(env.AUTH_JWKS_COOLDOWN_MS, 30_000),
    sessionStore,
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("JWT timing settings must be positive integers");
  }
  return parsed;
}

/** 单机/单测用 discovery stub（无真实 IdP） */
export function createLocalOidcDiscoveryStub(options: {
  issuer: string;
  jwksUri: string;
}): OidcDiscoveryDocument {
  return {
    issuer: options.issuer,
    jwks_uri: options.jwksUri,
    authorization_endpoint: `${options.issuer}authorize`,
    token_endpoint: `${options.issuer}token`,
  };
}
