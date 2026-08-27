import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import { JwtAuthProvider } from "./jwt-auth-provider.js";

export interface StagingMockAuthMaterial {
  jwks: { keys: JWK[] };
  issuer: string;
  audience: string;
  provider: JwtAuthProvider;
  issueToken(claims?: {
    subjectId?: string;
    tenantId?: string;
    roles?: string[];
  }): Promise<string>;
}

let cached: StagingMockAuthMaterial | null = null;
let privateKey: CryptoKey | null = null;

/**
 * 单机 staging mock IdP：jose 自签 RS256 + 内联 JWKS。
 * 仅在 APP_ENV=staging 且 BI_STAGING_MOCK_AUTH=1 时使用。
 */
export async function ensureStagingMockAuth(options?: {
  issuer?: string;
  audience?: string;
}): Promise<StagingMockAuthMaterial> {
  if (cached) return cached;

  const issuer = options?.issuer ?? "https://bi-analyst.staging.local/";
  const audience = options?.audience ?? "bi-analyst";
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256", {
    extractable: true,
  });
  privateKey = priv as CryptoKey;
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwk.kid = "staging-mock-1";
  const jwks = { keys: [jwk] };

  const provider = new JwtAuthProvider({
    jwks,
    issuer,
    audience,
  });

  cached = {
    jwks,
    issuer,
    audience,
    provider,
    async issueToken(claims = {}) {
      if (!privateKey) throw new Error("staging mock private key missing");
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        sub: claims.subjectId ?? "user-dev",
        tenant_id: claims.tenantId ?? "tenant-1",
        roles: claims.roles ?? ["analyst", "BI_QUERY_DEBUG", "BI_AUDIT_READER"],
      })
        .setProtectedHeader({ alg: "RS256", kid: "staging-mock-1" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);
    },
  };
  return cached;
}

export function getStagingMockAuth(): StagingMockAuthMaterial | null {
  return cached;
}

export function resetStagingMockAuthForTests(): void {
  cached = null;
  privateKey = null;
}

/** 是否启用单机 staging mock 认证 */
export function isStagingMockAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.APP_ENV === "staging" &&
    env.BI_STAGING_MOCK_AUTH === "1"
  );
}
