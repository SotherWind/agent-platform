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
import { createHash } from "node:crypto";
import { AuthenticationContextError } from "./errors";
import { MemorySessionBindingStore, type SessionBindingStore } from "./session-binding";
import { LeaseLostError, OperationInProgressError } from "./reliability/lease-store";
import { stableStringify } from "./tools/contract";
import type { RagBotInput, RetrievalScope } from "./type";
import { normalizeKnowledgeScope } from "./knowledge-scope";

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
  knowledgeScope?: RetrievalScope;
}

/**
 * 网关签发的受信会话上下文。
 *
 * 这个对象不是请求体里的数据结构：只有 AccessGateway 能创建带内部 brand 的
 * 实例，图入口会拒绝调用方手工拼出的同形对象。
 */
export interface AuthenticatedContext {
  readonly tenantId: string;
  readonly principal: string;
  readonly threadId: string;
  readonly traceId: string;
  readonly operationId: string;
  readonly scopes: readonly string[];
  readonly knowledgeScope: Readonly<RetrievalScope>;
}

interface Admission {
  input: RagBotInput;
  key: string;
  owner?: string;
  store: EntryIdempotencyStoreLike;
  status: "acquired" | "busy" | "completed";
  result?: unknown;
  sessions: SessionBindingStore;
}

const trustedContexts = new WeakMap<object, Admission>();

export function isTrustedAuthenticatedContext(
  value: unknown,
): value is AuthenticatedContext {
  return (
    typeof value === "object" &&
    value !== null &&
    trustedContexts.has(value) &&
    typeof (value as AuthenticatedContext).tenantId === "string" &&
    typeof (value as AuthenticatedContext).principal === "string" &&
    typeof (value as AuthenticatedContext).threadId === "string" &&
    typeof (value as AuthenticatedContext).traceId === "string"
  );
}

/** Only server-issued contexts reach this lifecycle; request JSON cannot create one. */
export async function runAdmitted<T>(
  context: AuthenticatedContext,
  work: () => Promise<T>,
): Promise<T> {
  const admission = trustedContexts.get(context);
  if (!admission) throw new AuthenticationContextError();
  if (admission.status === "completed") return structuredClone(admission.result) as T;
  if (admission.status === "busy" || !admission.owner) throw new OperationInProgressError(admission.key);
  if (!admission.store.renew(admission.key, admission.owner)) throw new LeaseLostError();
  let leaseLost = false;
  const timer = setInterval(() => {
    try {
      leaseLost ||= !admission.store.renew(admission.key, admission.owner!);
    } catch { leaseLost = true; }
  }, Math.max(1, Math.floor(admission.store.leaseMs / 3)));
  timer.unref();
  // Prevent two calls using the same context from starting the same graph.
  admission.status = "busy";
  try {
    return await admission.sessions.run(context.threadId, async () => {
      const result = await work();
      if (leaseLost || !admission.store.complete(admission.key, admission.owner!, result)) throw new LeaseLostError();
      admission.result = structuredClone(result);
      admission.status = "completed";
      return result;
    });
  } catch (error) {
    admission.store.fail(admission.key, admission.owner);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

export function assertAdmittedInput(
  context: AuthenticatedContext,
  input: RagBotInput,
): void {
  const admission = trustedContexts.get(context);
  if (!admission) throw new AuthenticationContextError();
  const expected = admission.input;
  if (
    input.query !== expected.query ||
    (input.confirmationProposalId ?? "") !== (expected.confirmationProposalId ?? "") ||
    (input.confirmationToken ?? "") !== (expected.confirmationToken ?? "") ||
    (input.transcriptConfidence ?? null) !== (expected.transcriptConfidence ?? null)
  ) {
    throw new AuthenticationContextError(
      "Request content does not match the admitted message.",
      { reasonCode: "message_content_mismatch" },
    );
  }
}

export interface Authenticator {
  authenticate(cred: Credential): Principal | null;
}

/** 入口请求。body.tenantId 字段刻意保留在类型里，是为了让调用方**看见**它会被忽略 */
export interface InboundRequest {
  credential: Credential;
  /** 渠道侧的消息唯一 ID，用于入口幂等 */
  messageId: string;
  /** 会话线程 ID；同一线程的租户与主体不可改变 */
  threadId?: string;
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
      context: AuthenticatedContext;
      /** true 表示同 messageId 已处理过，调用方不应再进入编排 */
      duplicate: boolean;
      processing: boolean;
      traceId: string;
    }
  | {
      ok: false;
      code: "unauthenticated" | "rate_limited" | "message_conflict" | "session_conflict";
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
    const identity = this.tokens.get(cred.token);
    return identity ? structuredClone(identity) : null;
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
  sessionBindings?: SessionBindingStore;
  environment?: "development" | "production";
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
  private readonly sessionBindings: SessionBindingStore;

  constructor(config: AccessGatewayConfig) {
    this.authenticator = config.authenticator;
    this.idempotency = config.idempotency;
    this.limiter = config.limiter;
    this.clock = config.clock ?? Date.now;
    this.sessionBindings = config.sessionBindings ?? new MemorySessionBindingStore();
    if ((config.environment === "production" || process.env.NODE_ENV === "production") &&
        (!this.idempotency.durable || !this.sessionBindings.durable)) {
      throw new Error("Production AccessGateway requires durable idempotency and session bindings.");
    }
  }

  admit(req: InboundRequest): AdmitResult {
    // 1) 鉴权：不通过直接短路，编排不可达
    let identity: Principal | null = null;
    try {
      identity = this.authenticator.authenticate(req.credential);
    } catch {
      identity = null;
    }
    if (!identity?.tenantId?.trim() || !identity.principal?.trim() || !req.messageId?.trim()) {
      return {
        ok: false,
        code: "unauthenticated",
        reason: "凭证无效或已过期，请重新登录后重试。",
      };
    }

    const threadId = req.threadId?.trim() || req.messageId.trim();
    const scope = normalizeKnowledgeScope(identity.knowledgeScope);
    const authorizationScope = createHash("sha256").update(stableStringify({
      scopes: [...(identity.scopes ?? [])].sort(),
      ...scope,
    })).digest("hex");
    if (!threadId) {
      return {
        ok: false,
        code: "unauthenticated",
        reason: "缺少有效的消息或会话标识。",
      };
    }
    try {
      this.sessionBindings.bind({ tenantId: identity.tenantId, principal: identity.principal, threadId, authorizationScope });
    } catch (error) {
      if (!(error instanceof AuthenticationContextError)) throw error;
      return {
        ok: false,
        code: "session_conflict",
        reason: "会话身份与原会话不一致，请重新建立会话。",
      };
    }

    // 2) 入口幂等：同一租户的 messageId 只占用一次。
    // 先返回 duplicate，重试不应进入限流器，也不应消耗租户配额。
    const idempotencyKey = JSON.stringify([identity.tenantId, identity.principal, req.messageId]);
    const input = {
      query: req.body.query,
      threadId,
      confirmationProposalId: typeof req.body.confirmationProposalId === "string" ? req.body.confirmationProposalId : "",
      confirmationToken: typeof req.body.confirmationToken === "string" ? req.body.confirmationToken : "",
      transcriptConfidence: typeof req.body.transcriptConfidence === "number" ? req.body.transcriptConfidence : null,
      history: [],
    } satisfies RagBotInput;
    const fingerprint = createHash("sha256").update(stableStringify({ input, authorizationScope })).digest("hex");
    const claim = this.idempotency.claim(idempotencyKey, fingerprint);
    if (claim.status === "conflict") {
      return { ok: false, code: "message_conflict", reason: "同一 messageId 不能用于不同请求。" };
    }
    const context = Object.freeze({
      tenantId: identity.tenantId,
      principal: identity.principal,
      threadId,
      traceId: `trace-${req.messageId}`,
      operationId: createHash("sha256").update(idempotencyKey).digest("hex"),
      scopes: Object.freeze([...(identity.scopes ?? [])]),
      knowledgeScope: Object.freeze({
        products: Object.freeze([...(scope?.products ?? [])]),
        regions: Object.freeze([...(scope?.regions ?? [])]),
        roles: Object.freeze([...(scope?.roles ?? [])]),
        permissions: Object.freeze([...(scope?.permissions ?? [])]),
      }),
    }) satisfies AuthenticatedContext;
    trustedContexts.set(context, {
      input, key: idempotencyKey, store: this.idempotency, status: claim.status,
      sessions: this.sessionBindings,
      ...(claim.status === "acquired" ? { owner: claim.owner } : {}),
      ...(claim.status === "completed" ? { result: claim.result } : {}),
    });
    if (claim.status !== "acquired") {
      return {
        ok: true,
        identity: structuredClone(identity),
        context,
        duplicate: true,
        processing: claim.status === "busy",
        traceId: context.traceId,
      };
    }

    // 3) 租户级限流（隔离舱）
    const rate = this.limiter.check(identity.tenantId);
    if (!rate.allowed) {
      this.idempotency.fail(idempotencyKey, claim.owner);
      trustedContexts.delete(context);
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
      identity: structuredClone(identity),
      context,
      duplicate: false,
      processing: false,
      traceId: context.traceId,
    };
  }

  toGraphInput(result: Extract<AdmitResult, { ok: true }>): RagBotInput {
    const admission = trustedContexts.get(result.context);
    if (!admission) throw new AuthenticationContextError();
    return { ...structuredClone(admission.input), authContext: result.context };
  }
}
