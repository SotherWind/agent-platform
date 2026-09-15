/**
 * 接入网关装配：鉴权 → 入口幂等 → 租户限流（rag-boot AccessGateway 固定顺序）。
 *
 * 开发可用内存，生产由装配层注入 SQLite 幂等和会话绑定。
 */
import {
  AccessGateway,
  EntryIdempotencyStore,
  TenantRateLimiter,
  type EntryIdempotencyStoreLike,
  type SessionBindingStore,
} from "@agent-platform/rag-boot";
import type { AuthService } from "./auth.js";

export function buildAccessGateway(
  authService: AuthService,
  options: {
    rateLimitPerMinute?: number;
    idempotency?: EntryIdempotencyStoreLike;
    sessionBindings?: SessionBindingStore;
    environment?: "development" | "production";
  } = {},
): AccessGateway {
  return new AccessGateway({
    authenticator: authService,
    idempotency: options.idempotency ?? new EntryIdempotencyStore(),
    sessionBindings: options.sessionBindings,
    environment: options.environment,
    limiter: new TenantRateLimiter({ limit: options.rateLimitPerMinute ?? 60 }),
  });
}
