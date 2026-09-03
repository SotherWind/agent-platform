/**
 * T9.2 接入层：鉴权、租户识别、限流、入口幂等
 *
 * 安全底线（对应清单第 749 行）：`tenantId` 必须来自**鉴权凭证**，
 * 绝不从请求体读取。请求体里的 tenantId 一律忽略。
 *
 * 这条与 T2.3「对话内容中声称身份不改变过滤范围」是同一道防线的两端：
 * - T2.3 管下游：检索与生成按租户硬过滤
 * - T9.2 管上游：租户身份本身不可伪造
 * 只做下游那半，等于过滤一个可被伪造的 key，形同虚设。
 */
import type { EntryIdempotencyStoreLike } from "./entry-idempotency";

export {
  EntryIdempotencyStore,
  SqliteEntryIdempotencyStore,
  SQLiteEntryIdempotencyStore,
} from "./entry-idempotency";
export type {
  EntryIdempotencyStoreLike,
  EntryIdempotencyStoreOptions,
  SqliteEntryIdempotencyStoreOptions,
} from "./entry-idempotency";

/** 凭证形态。目前只需 token，保留接口形状以便后续接 JWT / HMAC */
export interface Credential {
  token: string;
}

/** 鉴权后的会话身份。这是全链路租户身份的**唯一**来源 */
export interface Principal {
  tenantId: string;
  /** 人或系统的标识，用于审计归因 */
  principal: string;
  scopes?: string[];
}

export interface Authenticator {
  authenticate(cred: Credential): Principal | null;
}

/** 入口请求。body.tenantId 字段刻意保留在类型里，是为了让调用方**看见**它会被忽略 */
export interface InboundRequest {
  credential: Credential;
  /** 渠道侧的消息唯一 ID，用于入口幂等 */
  messageId: string;
  body: {
    query: string;
    /** ⚠️ 不安全输入：接入层不会采信此字段 */
    tenantId?: string;
    [key: string]: unknown;
  };
}

export type AdmitResult =
  | {
      ok: true;
      identity: Principal;
      /** true 表示同 messageId 已处理过，调用方不应再进入编排 */
      duplicate: boolean;
      traceId: string;
    }
  | {
      ok: false;
      code: "unauthenticated" | "rate_limited";
      reason: string;
      retryAfterMs?: number;
    };

/** 静态 token → 身份映射的鉴权器 */
export class TokenAuthenticator implements Authenticator {
  private readonly tokens: Map<string, Principal>;

  constructor(tokens: Record<string, Principal>) {
    this.tokens = new Map(Object.entries(tokens));
  }

  authenticate(cred: Credential): Principal | null {
    if (!cred?.token) return null;
    return this.tokens.get(cred.token) ?? null;
  }
}

/**
 * 租户级限流（隔离舱）：每个租户独立计数。
 * 单租户异常流量只能打满自己的配额，不影响其他租户。
 */
export class TenantRateLimiter {
  private readonly counters = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(opts: { limit?: number; windowMs?: number; clock?: () => number } = {}) {
    this.limit = opts.limit ?? 60;
    this.windowMs = opts.windowMs ?? 60_000;
    this.clock = opts.clock ?? Date.now;
  }

  /** 返回 { allowed, retryAfterMs } */
  check(tenantId: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.clock();
    const recent = (this.counters.get(tenantId) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (recent.length >= this.limit) {
      const oldest = recent[0];
      this.counters.set(tenantId, recent);
      return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - oldest)) };
    }
    recent.push(now);
    this.counters.set(tenantId, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

export interface AccessGatewayConfig {
  authenticator: Authenticator;
  idempotency: EntryIdempotencyStoreLike;
  limiter: TenantRateLimiter;
  clock?: () => number;
}

/**
 * 接入层网关：`admit()` 是编排的唯一入口。
 *
 * 顺序刻意固定为 鉴权 → 幂等 → 限流：
 * 鉴权先行，否则未认证请求也能消耗租户配额（可被用来打配额耗尽攻击）；
 * 幂等先于限流，否则重试请求会被限流误杀，Webhook 重试语义被破坏。
 */
export class AccessGateway {
  private readonly authenticator: Authenticator;
  private readonly idempotency: EntryIdempotencyStoreLike;
  private readonly limiter: TenantRateLimiter;
  private readonly clock: () => number;

  constructor(config: AccessGatewayConfig) {
    this.authenticator = config.authenticator;
    this.idempotency = config.idempotency;
    this.limiter = config.limiter;
    this.clock = config.clock ?? Date.now;
  }

  admit(req: InboundRequest): AdmitResult {
    // 1) 鉴权：不通过直接短路，编排不可达
    let identity: Principal | null = null;
    try {
      identity = this.authenticator.authenticate(req.credential);
    } catch {
      identity = null;
    }
    if (!identity) {
      return {
        ok: false,
        code: "unauthenticated",
        reason: "凭证无效或已过期，请重新登录后重试。",
      };
    }

    // 2) 入口幂等：同一租户的 messageId 只占用一次。
    // 先返回 duplicate，重试不应进入限流器，也不应消耗租户配额。
    const idempotencyKey = `${identity.tenantId}:${req.messageId}`;
    const first = this.idempotency.first(idempotencyKey);
    if (!first) {
      return {
        ok: true,
        identity,
        duplicate: true,
        traceId: `trace-${req.messageId}`,
      };
    }

    // 3) 租户级限流（隔离舱）
    const rate = this.limiter.check(identity.tenantId);
    if (!rate.allowed) {
      this.idempotency.release?.(idempotencyKey);
      return {
        ok: false,
        code: "rate_limited",
        reason: `请求过于频繁，已超出当前套餐的速率限制，请在 ${Math.ceil(rate.retryAfterMs / 1000)} 秒后重试。`,
        retryAfterMs: rate.retryAfterMs,
      };
    }

    return {
      ok: true,
      // tenantId 只来自凭证；req.body.tenantId 被显式丢弃
      identity,
      duplicate: false,
      traceId: `trace-${req.messageId}`,
    };
  }
}
