/**
 * T5.4 工单生命周期
 *
 * 清单 580 行点明了这件事的分量：工单关闭时记录「解决方式」是 T7.2 计算 resolution rate
 * 的**数据前提**。没有「解决方式」和「是否二次来访」的记录，主指标就算不出来，
 * 最后只能退回用 deflection 汇报——这正是 Klarna 那类翻车的机制根源。
 *
 * 所以这个模块表面上是个状态机，实际是评测闭环的数据底座。
 */
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export const TicketStatusSchema = z.enum([
  "open",
  "assigned",
  "pending",
  "resolved",
  "closed",
]);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** 解决方式：resolutionRate 的分子分母都依赖它 */
export const TicketResolutionSchema = z.enum([
  "agent-resolved",
  "human-resolved",
  "abandoned",
]);
export type TicketResolution = z.infer<typeof TicketResolutionSchema>;

export const TicketTransitionSchema = z.object({
  from: TicketStatusSchema,
  to: TicketStatusSchema,
  at: z.number(),
  by: z.string(),
  note: z.string().optional(),
});
export type TicketTransition = z.infer<typeof TicketTransitionSchema>;

export const TicketSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  threadId: z.string(),
  category: z.string().default("general"),
  subject: z.string().default(""),
  status: TicketStatusSchema.default("open"),
  assignee: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable().default(null),
  /** 关闭时必填（abandoned 除外也要填，否则指标算不出来） */
  resolution: TicketResolutionSchema.nullable().default(null),
  /** 是否人工介入过 */
  humanInvolved: z.boolean().default(false),
  /** 是否二次来访（同一 thread 关闭后又开了新单） */
  secondVisit: z.boolean().default(false),
  rating: z.number().min(1).max(5).nullable().default(null),
  ratingComment: z.string().nullable().default(null),
  ratingCategory: z.string().nullable().default(null),
  history: z.array(TicketTransitionSchema).default(() => []),
  /** 关联的交接包（T5.2） */
  handoff: z.record(z.string(), z.unknown()).nullable().default(null),
  /** 幂等键：重复触发不产生两张单 */
  idempotencyKey: z.string().nullable().default(null),
});

export type Ticket = z.infer<typeof TicketSchema>;

/** 合法状态转移表。closed 为终态。
 * open → resolved 必须合法：升级创建的工单可被 Agent 直接解决
 * （close() 对未 resolved 的单会先补 resolved 再 closed，保证 history 完整），
 * 否则 agent-resolved 这类解决方式根本走不到，T7.2 的 resolutionRate 少一块分子。 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["assigned", "resolved", "closed"],
  assigned: ["pending", "resolved", "closed", "open"],
  pending: ["assigned", "resolved", "closed"],
  resolved: ["closed", "open"],
  closed: [],
};

export function isTransitionAllowed(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class IllegalTicketTransitionError extends Error {
  readonly reasonCode = "illegal_transition";
  constructor(from: TicketStatus, to: TicketStatus) {
    super(`Illegal ticket transition: ${from} -> ${to}`);
    this.name = "IllegalTicketTransitionError";
  }
}

export interface TicketStore {
  readonly durable: boolean;
  create(input: Omit<Ticket, "id" | "createdAt" | "updatedAt" | "history">): Promise<Ticket>;
  get(id: string): Promise<Ticket | undefined>;
  update(ticket: Ticket): Promise<void>;
  list(opts?: { tenantId?: string; threadId?: string }): Promise<Ticket[]>;
  findByIdempotencyKey(key: string): Promise<Ticket | undefined>;
}

export class InMemoryTicketStore implements TicketStore {
  readonly durable = false;
  private readonly map = new Map<string, Ticket>();

  async create(input: Omit<Ticket, "id" | "createdAt" | "updatedAt" | "history">): Promise<Ticket> {
    const now = Date.now();
    const ticket = TicketSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      history: [],
    });
    this.map.set(ticket.id, ticket);
    return ticket;
  }
  async get(id: string): Promise<Ticket | undefined> {
    return this.map.get(id);
  }
  async update(ticket: Ticket): Promise<void> {
    this.map.set(ticket.id, ticket);
  }
  async list(opts: { tenantId?: string; threadId?: string } = {}): Promise<Ticket[]> {
    return [...this.map.values()].filter(
      (t) =>
        (opts.tenantId === undefined || t.tenantId === opts.tenantId) &&
        (opts.threadId === undefined || t.threadId === opts.threadId),
    );
  }
  async findByIdempotencyKey(key: string): Promise<Ticket | undefined> {
    return [...this.map.values()].find((t) => t.idempotencyKey === key);
  }
}

/** Durable ticket adapter used by the production assembly. */
export class SqliteTicketStore implements TicketStore {
  readonly durable: boolean;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.durable = path !== ":memory:" && path !== "";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        ticket TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_tenant_thread
        ON tickets (tenant_id, thread_id);
    `);
  }

  async create(input: Omit<Ticket, "id" | "createdAt" | "updatedAt" | "history">): Promise<Ticket> {
    const now = Date.now();
    const ticket = TicketSchema.parse({ ...input, id: randomUUID(), createdAt: now, updatedAt: now, history: [] });
    this.db.prepare(`
      INSERT OR IGNORE INTO tickets (id, tenant_id, thread_id, idempotency_key, ticket)
      VALUES (?, ?, ?, ?, ?)
    `).run(ticket.id, ticket.tenantId, ticket.threadId, ticket.idempotencyKey, JSON.stringify(ticket));
    return (await this.findByIdempotencyKey(ticket.idempotencyKey ?? "")) ?? ticket;
  }

  async get(id: string): Promise<Ticket | undefined> {
    const row = this.db.prepare("SELECT ticket FROM tickets WHERE id = ?").get(id) as { ticket: string } | undefined;
    return row ? TicketSchema.parse(JSON.parse(row.ticket)) : undefined;
  }
  async update(ticket: Ticket): Promise<void> {
    this.db.prepare(`
      UPDATE tickets SET tenant_id = ?, thread_id = ?, idempotency_key = ?, ticket = ? WHERE id = ?
    `).run(ticket.tenantId, ticket.threadId, ticket.idempotencyKey, JSON.stringify(ticket), ticket.id);
  }
  async list(opts: { tenantId?: string; threadId?: string } = {}): Promise<Ticket[]> {
    const rows = this.db.prepare(`
      SELECT ticket FROM tickets
      WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR thread_id = ?)
    `).all(opts.tenantId ?? null, opts.tenantId ?? null, opts.threadId ?? null, opts.threadId ?? null) as Array<{ ticket: string }>;
    return rows.map((row) => TicketSchema.parse(JSON.parse(row.ticket)));
  }
  async findByIdempotencyKey(key: string): Promise<Ticket | undefined> {
    if (!key) return undefined;
    const row = this.db.prepare("SELECT ticket FROM tickets WHERE idempotency_key = ?").get(key) as { ticket: string } | undefined;
    return row ? TicketSchema.parse(JSON.parse(row.ticket)) : undefined;
  }
  close(): void { this.db.close(); }
}

export interface TicketServiceOptions {
  store?: TicketStore;
  clock?: () => number;
}

/**
 * 工单服务：状态机 + 二次来访识别 + 评价回流。
 *
 * 二次来访的判定刻意放在**创建**时：同一 threadId 下若已有 closed 工单，
 * 新单标记 secondVisit = true。这是 resolution rate 分母里「无二次来访」的来源。
 */
export class TicketService {
  readonly durable: boolean;
  private readonly store: TicketStore;
  private readonly clock: () => number;

  constructor(options: TicketServiceOptions = {}) {
    this.store = options.store ?? new InMemoryTicketStore();
    this.durable = this.store.durable;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * 创建工单（幂等：同 idempotencyKey 重复触发返回既有单，不产生第二张）。
   */
  async create(input: {
    tenantId: string;
    threadId: string;
    category?: string;
    subject?: string;
    handoff?: Record<string, unknown>;
    humanInvolved?: boolean;
    idempotencyKey?: string;
  }): Promise<Ticket> {
    if (input.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }

    const closedBefore = await this.closedCountForThread(input.threadId, input.tenantId);

    return this.store.create({
      tenantId: input.tenantId,
      threadId: input.threadId,
      category: input.category ?? "general",
      subject: input.subject ?? "",
      status: "open",
      assignee: null,
      closedAt: null,
      resolution: null,
      humanInvolved: input.humanInvolved ?? false,
      secondVisit: closedBefore > 0,
      rating: null,
      ratingComment: null,
      ratingCategory: null,
      handoff: input.handoff ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  }

  async closedCountForThread(threadId: string, tenantId: string): Promise<number> {
    const tickets = await this.store.list({ threadId, tenantId });
    return tickets.filter((t) => t.status === "closed").length;
  }

  /** 状态转移：非法转移直接抛错，状态不允许被写坏 */
  async transition(input: {
    ticketId: string;
    to: TicketStatus;
    by?: string;
    note?: string;
  }): Promise<Ticket> {
    const ticket = await this.store.get(input.ticketId);
    if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);

    if (!isTransitionAllowed(ticket.status, input.to)) {
      throw new IllegalTicketTransitionError(ticket.status, input.to);
    }

    const now = this.clock();
    const next: Ticket = {
      ...ticket,
      status: input.to,
      updatedAt: now,
      closedAt: input.to === "closed" ? now : null,
      history: [
        ...ticket.history,
        { from: ticket.status, to: input.to, at: now, by: input.by ?? "system", note: input.note },
      ],
    };
    await this.store.update(next);
    return next;
  }

  /**
   * 关闭工单：**必须**记录解决方式。
   * 没记 resolution 的关闭会被拒绝——宁可流程报错，也不要产出无法计算指标的脏数据。
   */
  async close(input: {
    ticketId: string;
    resolution: TicketResolution;
    by?: string;
    humanInvolved?: boolean;
  }): Promise<Ticket> {
    const ticket = await this.store.get(input.ticketId);
    if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);

    const toClose: TicketStatus = ticket.status === "closed" ? "closed" : "closed";
    if (ticket.status !== "resolved" && ticket.status !== "closed") {
      // 未 resolved 直接关闭：先落到 resolved 再 closed，保证 history 完整
      await this.transition({ ticketId: ticket.id, to: "resolved", by: input.by ?? "system" });
    }

    const current = (await this.store.get(input.ticketId)) as Ticket;
    const now = this.clock();
    const next: Ticket = {
      ...current,
      status: toClose,
      resolution: input.resolution,
      humanInvolved: input.humanInvolved ?? current.humanInvolved,
      closedAt: now,
      updatedAt: now,
      history: [
        ...current.history.filter((h) => !(h.to === "closed")),
        {
          from: current.status,
          to: "closed",
          at: now,
          by: input.by ?? "system",
          note: input.resolution,
        },
      ],
    };
    await this.store.update(next);
    return next;
  }

  /** 评价回流：关联到具体会话与专家类别（T7.2 满意度门槛的数据来源） */
  async rate(input: {
    ticketId: string;
    rating: number;
    comment?: string;
    category?: string;
  }): Promise<Ticket> {
    const ticket = await this.store.get(input.ticketId);
    if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);
    if (input.rating < 1 || input.rating > 5) {
      throw new Error("rating must be between 1 and 5");
    }
    const next: Ticket = {
      ...ticket,
      rating: input.rating,
      ratingComment: input.comment ?? null,
      ratingCategory: input.category ?? ticket.category,
      updatedAt: this.clock(),
    };
    await this.store.update(next);
    return next;
  }

  async get(id: string): Promise<Ticket | undefined> {
    return this.store.get(id);
  }

  /** 从工单反查完整会话所需的线程 ID（T5.4 第 4 条） */
  async getThreadId(ticketId: string): Promise<string | undefined> {
    const t = await this.store.get(ticketId);
    return t?.threadId;
  }

  async list(opts: { tenantId?: string; threadId?: string } = {}): Promise<Ticket[]> {
    return this.store.list(opts);
  }
}
