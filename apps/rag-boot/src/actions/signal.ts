/**
 * T3.5 CRM / 业务系统 action-trigger 集成
 *
 * 依据 Swiggy：Agent 与 CRM 之间**不是直接改库**，而是结构化的 action-trigger 集成——
 * Agent 产生决策后以 action signal 形式通知 CRM，由 CRM 侧执行。
 *
 * 这样解耦带来的好处（清单 467 行）：业务系统不可用时，signal 可堆积重放，
 * Agent 侧不会因下游故障而失败，也不会出现「Agent 说已退款但 CRM 没收到」的不一致。
 *
 * 与 T5.3 的分工：
 * - T5.3 管「Agent → 用户」的确认（用户点了才算数）
 * - T3.5 管「Agent → 业务系统」的投递（确认之后由确定性后端执行）
 */
import { z } from "zod/v4";
import Database from "better-sqlite3";

export const ActionSignalSchema = z.object({
  id: z.string().describe("signal 唯一 ID"),
  type: z.string().describe("动作类型，如 refund / plan_change / credential_reset"),
  tenantId: z.string(),
  threadId: z.string(),
  /** 会话身份：写操作授权只取会话层身份（验证文档硬要求） */
  principal: z.string(),
  /** 幂等键：下游重复投递只产生一次副作用 */
  idempotencyKey: z.string(),
  payload: z.record(z.string(), z.unknown()).describe("动作参数"),
  /** 决策依据：为什么 Agent 认为该做这个动作，供人工复核 */
  decisionBasis: z.array(z.string()).default(() => []),
  createdAt: z.number(),
  status: z
    .enum(["pending", "dispatched", "failed", "acked"])
    .default("pending"),
  attempts: z.number().default(0),
  lastError: z.string().nullable().default(null),
});

export type ActionSignal = z.infer<typeof ActionSignalSchema>;

export const ActionSignalResultSchema = z.object({
  signalId: z.string(),
  ok: z.boolean(),
  /** 下游返回的原始结果 */
  response: z.unknown().nullable().default(null),
  error: z.string().nullable().default(null),
  at: z.number(),
});

export type ActionSignalResult = z.infer<typeof ActionSignalResultSchema>;

/** 下游 CRM 执行器。确定性代码，绝不经过 LLM */
export type ActionSignalHandler = (
  signal: ActionSignal,
) => Promise<Record<string, unknown>>;

export interface ActionSignalStore {
  put(signal: ActionSignal): Promise<void>;
  get(id: string): Promise<ActionSignal | undefined>;
  update(signal: ActionSignal): Promise<void>;
  list(opts?: { status?: ActionSignal["status"] }): Promise<ActionSignal[]>;
  findByIdempotencyKey(key: string): Promise<ActionSignal | undefined>;
}

export class InMemoryActionSignalStore implements ActionSignalStore {
  private readonly map = new Map<string, ActionSignal>();

  async put(signal: ActionSignal): Promise<void> {
    this.map.set(signal.id, signal);
  }
  async get(id: string): Promise<ActionSignal | undefined> {
    return this.map.get(id);
  }
  async update(signal: ActionSignal): Promise<void> {
    this.map.set(signal.id, signal);
  }
  async list(opts: { status?: ActionSignal["status"] } = {}): Promise<ActionSignal[]> {
    const all = [...this.map.values()];
    return opts.status ? all.filter((s) => s.status === opts.status) : all;
  }
  async findByIdempotencyKey(key: string): Promise<ActionSignal | undefined> {
    return [...this.map.values()].find((s) => s.idempotencyKey === key);
  }
}

/** 落盘 signal 存储：进程重启后仍可重放 */
export class SqliteActionSignalStore implements ActionSignalStore {
  private readonly db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS action_signals (
         id TEXT PRIMARY KEY,
         type TEXT NOT NULL,
         tenant_id TEXT NOT NULL,
         thread_id TEXT NOT NULL,
         principal TEXT NOT NULL,
         idempotency_key TEXT NOT NULL UNIQUE,
         signal TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_signals_status ON action_signals (id);`,
    );
  }

  async put(signal: ActionSignal): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO action_signals
         (id, type, tenant_id, thread_id, principal, idempotency_key, signal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        signal.id,
        signal.type,
        signal.tenantId,
        signal.threadId,
        signal.principal,
        signal.idempotencyKey,
        JSON.stringify(signal),
      );
  }

  async get(id: string): Promise<ActionSignal | undefined> {
    const row = this.db
      .prepare(`SELECT signal FROM action_signals WHERE id = ?`)
      .get(id) as { signal: string } | undefined;
    return row ? (JSON.parse(row.signal) as ActionSignal) : undefined;
  }

  async update(signal: ActionSignal): Promise<void> {
    await this.put(signal);
  }

  async list(opts: { status?: ActionSignal["status"] } = {}): Promise<ActionSignal[]> {
    const rows = this.db
      .prepare(`SELECT signal FROM action_signals`)
      .all() as Array<{ signal: string }>;
    const all = rows.map((r) => JSON.parse(r.signal) as ActionSignal);
    return opts.status ? all.filter((s) => s.status === opts.status) : all;
  }

  async findByIdempotencyKey(key: string): Promise<ActionSignal | undefined> {
    const row = this.db
      .prepare(`SELECT signal FROM action_signals WHERE idempotency_key = ?`)
      .get(key) as { signal: string } | undefined;
    return row ? (JSON.parse(row.signal) as ActionSignal) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

export interface ActionSignalBusOptions {
  store?: ActionSignalStore;
  handler?: ActionSignalHandler;
  clock?: () => number;
  /** 审计：signal 与 execute 结果分别落日志（清单 463 行） */
  onAudit?: (entry: { kind: "signal" | "result"; data: unknown; at: number }) => void;
}

/**
 * Action Signal 总线。
 *
 * 三条硬约束：
 * 1. `emit()` 只投递信号，**不执行**任何写操作——Agent 侧与业务系统侧解耦。
 * 2. 幂等：同 idempotencyKey 只产生一条 signal。
 * 3. 失败可重放：`replayFailed()` 重投失败的 signal，不重复已成功的。
 */
export class ActionSignalBus {
  private readonly store: ActionSignalStore;
  private readonly handler?: ActionSignalHandler;
  private readonly clock: () => number;
  private readonly onAudit?: ActionSignalBusOptions["onAudit"];

  constructor(options: ActionSignalBusOptions = {}) {
    this.store = options.store ?? new InMemoryActionSignalStore();
    this.handler = options.handler;
    this.clock = options.clock ?? Date.now;
    this.onAudit = options.onAudit;
  }

  private audit(kind: "signal" | "result", data: unknown): void {
    this.onAudit?.({ kind, data, at: this.clock() });
  }

  /**
   * 产出 signal。幂等：同 key 重复调用返回既有 signal。
   * 这是「Agent 决策产出 ActionSignal 而非直接调用 CRM 写接口」的代码保证。
   */
  async emit(input: {
    type: string;
    tenantId: string;
    threadId: string;
    principal: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    decisionBasis?: string[];
  }): Promise<ActionSignal> {
    const existing = await this.store.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const signal: ActionSignal = ActionSignalSchema.parse({
      id: `sig-${input.idempotencyKey}`,
      type: input.type,
      tenantId: input.tenantId,
      threadId: input.threadId,
      principal: input.principal,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      decisionBasis: input.decisionBasis ?? [],
      createdAt: this.clock(),
      status: "pending",
      attempts: 0,
      lastError: null,
    });

    await this.store.put(signal);
    this.audit("signal", signal);
    return signal;
  }

  /** 投递到 CRM 侧执行器（确定性代码路径） */
  async dispatch(
    signalId: string,
    handler: ActionSignalHandler = this.handler as ActionSignalHandler,
  ): Promise<ActionSignalResult> {
    const signal = await this.store.get(signalId);
    if (!signal) {
      return {
        signalId,
        ok: false,
        response: null,
        error: `signal ${signalId} not found`,
        at: this.clock(),
      };
    }
    if (signal.status === "acked") {
      return {
        signalId,
        ok: true,
        response: null,
        error: null,
        at: this.clock(),
      };
    }
    if (!handler) {
      return {
        signalId,
        ok: false,
        response: null,
        error: "no handler configured",
        at: this.clock(),
      };
    }

    try {
      const response = await handler(signal);
      await this.store.update({
        ...signal,
        status: "acked",
        attempts: signal.attempts + 1,
        lastError: null,
      });
      const result: ActionSignalResult = {
        signalId,
        ok: true,
        response,
        error: null,
        at: this.clock(),
      };
      this.audit("result", result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.store.update({
        ...signal,
        status: "failed",
        attempts: signal.attempts + 1,
        lastError: error,
      });
      const result: ActionSignalResult = {
        signalId,
        ok: false,
        response: null,
        error,
        at: this.clock(),
      };
      this.audit("result", result);
      return result;
    }
  }

  /** 重放失败的 signal（业务系统恢复后补投） */
  async replayFailed(
    handler: ActionSignalHandler = this.handler as ActionSignalHandler,
  ): Promise<ActionSignalResult[]> {
    const failed = await this.store.list({ status: "failed" });
    const results: ActionSignalResult[] = [];
    for (const signal of failed) {
      results.push(await this.dispatch(signal.id, handler));
    }
    return results;
  }

  async list(status?: ActionSignal["status"]): Promise<ActionSignal[]> {
    return this.store.list(status ? { status } : {});
  }
}
