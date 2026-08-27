import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import type { AuthenticatedPrincipal } from "./types.js";
import { AuthError } from "./principal.js";
import type { AuthProvider } from "../config/types.js";

export interface JwtAuthProviderOptions {
  jwksUrl?: string;
  jwks?: { keys: JWK[] };
  issuer?: string;
  audience?: string | string[];
  algorithms?: string[];
  jwksTimeoutMs?: number;
  jwksCacheTtlMs?: number;
  jwksCooldownMs?: number;
  fetchImpl?: typeof fetch;
  onJwksFailure?: (details: { code: string; message: string }) => void;
  claimMap?: {
    subjectId?: string;
    tenantId?: string;
    roles?: string;
  };
}

type JwksResolver =
  | ReturnType<typeof createLocalJWKSet>
  | ReturnType<typeof createRemoteJWKSet>;

const SAFE_JWT_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

/** Verifies Bearer JWTs against a bounded, rotating JWKS resolver. */
export class JwtAuthProvider implements AuthProvider {
  private readonly getKey: JwksResolver;
  private readonly remote: boolean;
  private readonly issuer?: string;
  private readonly audience?: string | string[];
  private readonly algorithms: string[];
  private readonly onJwksFailure?: JwtAuthProviderOptions["onJwksFailure"];
  private readonly claimMap: Required<
    NonNullable<JwtAuthProviderOptions["claimMap"]>
  >;

  constructor(options: JwtAuthProviderOptions) {
    if (!options.jwksUrl && !options.jwks) {
      throw new Error("JwtAuthProvider requires jwksUrl or jwks");
    }
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.algorithms = options.algorithms?.length
      ? [...options.algorithms]
      : ["RS256"];
    if (this.algorithms.some((algorithm) => !SAFE_JWT_ALGORITHMS.has(algorithm))) {
      throw new Error("JwtAuthProvider received an unsupported JWT algorithm");
    }
    this.onJwksFailure = options.onJwksFailure;
    this.claimMap = {
      subjectId: options.claimMap?.subjectId ?? "sub",
      tenantId: options.claimMap?.tenantId ?? "tenant_id",
      roles: options.claimMap?.roles ?? "roles",
    };

    if (options.jwks) {
      this.getKey = createLocalJWKSet(options.jwks);
      this.remote = false;
    } else {
      const remoteOptions: Parameters<typeof createRemoteJWKSet>[1] = {
        timeoutDuration: options.jwksTimeoutMs ?? 5_000,
        cacheMaxAge: options.jwksCacheTtlMs ?? 600_000,
        cooldownDuration: options.jwksCooldownMs ?? 30_000,
      };
      if (options.fetchImpl) remoteOptions[customFetch] = options.fetchImpl;
      this.getKey = createRemoteJWKSet(new URL(options.jwksUrl!), remoteOptions);
      this.remote = true;
    }
  }

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedPrincipal> {
    const token = extractBearerToken(headers);
    if (!token) {
      throw new AuthError("Missing Authorization Bearer token", "unauthenticated");
    }

    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: this.algorithms,
      });
      return mapPayloadToPrincipal(payload, this.claimMap);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (this.remote && isJwksFailure(error)) {
        this.onJwksFailure?.({
          code: errorCode(error),
          message: message.slice(0, 300),
        });
      }
      throw new AuthError(`JWT validation failed: ${message}`, "unauthenticated");
    }
  }
}

export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw =
    headers.authorization ??
    headers.Authorization ??
    headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function mapPayloadToPrincipal(
  payload: JWTPayload,
  claimMap: Required<NonNullable<JwtAuthProviderOptions["claimMap"]>>,
): AuthenticatedPrincipal {
  const subjectId = claimAsString(payload[claimMap.subjectId] ?? payload.sub);
  if (!subjectId) {
    throw new AuthError("JWT is missing subject (sub)", "unauthenticated");
  }

  const tenantId = claimAsString(
    payload[claimMap.tenantId] ?? payload.tid ?? payload.tenantId,
  );
  if (!tenantId) {
    throw new AuthError("JWT is missing tenant_id", "unauthenticated");
  }

  return {
    subjectId,
    tenantId,
    roles: claimAsRoles(payload[claimMap.roles] ?? payload.groups),
    claims: { ...payload } as Record<string, unknown>,
  };
}

function claimAsString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function claimAsRoles(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

function isJwksFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code.startsWith("ERR_JWKS_") || code === "ERR_JOSE_GENERIC";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "JWKS_FAILURE";
}

/** Builds a JWT provider from environment configuration. */
export function createJwtAuthProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JwtAuthProvider | null {
  const issuer = env.AUTH_ISSUER?.trim() || undefined;
  const audience = env.AUTH_AUDIENCE?.trim() || undefined;
  const isDeployed = env.APP_ENV === "staging" || env.APP_ENV === "production";
  if (isDeployed && (!issuer || !audience)) {
    throw new Error(
      "AUTH_ISSUER and AUTH_AUDIENCE are required outside local environments",
    );
  }

  const common = {
    issuer,
    audience,
    algorithms: parseJwtAlgorithmList(env.AUTH_ALLOWED_ALGORITHMS),
    jwksTimeoutMs: positiveInteger(env.AUTH_JWKS_TIMEOUT_MS, 5_000),
    jwksCacheTtlMs: positiveInteger(env.AUTH_JWKS_CACHE_TTL_MS, 600_000),
    jwksCooldownMs: positiveInteger(env.AUTH_JWKS_COOLDOWN_MS, 30_000),
    onJwksFailure: (details: { code: string; message: string }) => {
      console.error(JSON.stringify({ event: "auth.jwks_failure", ...details }));
    },
  };

  const inline = env.AUTH_JWKS_JSON?.trim();
  if (inline) {
    try {
      const jwks = JSON.parse(inline) as { keys: JWK[] };
      if (!jwks.keys?.length) return null;
      return new JwtAuthProvider({ jwks, ...common });
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("AUTH_JWKS_JSON is not valid JWKS JSON");
      }
      throw error;
    }
  }

  const jwksUrl = env.AUTH_JWKS_URL?.trim();
  if (!jwksUrl) return null;
  return new JwtAuthProvider({ jwksUrl, ...common });
}

export function parseJwtAlgorithmList(value: string | undefined): string[] {
  const algorithms = (value?.split(",") ?? ["RS256"])
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    algorithms.length === 0 ||
    algorithms.some((algorithm) => !SAFE_JWT_ALGORITHMS.has(algorithm))
  ) {
    throw new Error("AUTH_ALLOWED_ALGORITHMS contains an unsupported JWT algorithm");
  }
  return [...new Set(algorithms)];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("JWT timing settings must be positive integers");
  }
  return parsed;
}
