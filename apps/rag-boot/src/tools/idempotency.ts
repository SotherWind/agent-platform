/**
 * T3.2 幂等键存储
 *
 * 依据 MCP 2026-07-28 规范修订：流恢复机制取消，客户端会**重发**中断的调用，
 * 因此工具必须幂等。不幂等的后果是重复退款、重复建单。
 *
 * 与 T9.2 入口幂等的分工：
 * - T9.2 挡「同一条渠道消息被投递两次」
 * - T3.2 挡「同一次编排内部工具被重发 / 重试」
 * 两层都要有，因为重试可以发生在入口之后（LLM 超时重试、节点重放）。
 */
import Database from "better-sqlite3";

export interface IdempotencyTicket<T> {
  /** true 表示该 key 已执行过，副作用不会再次发生 */
  hit: boolean;
  /** 命中时返回的上次结果 */
  result?: T;
  /** 未命中时，执行成功后回填结果，供后续重发直接返回 */
  commit(result: T): Promise<void>;
  /** 执行失败时释放占位，允许后续重试。 */
  rollback?(): Promise<void>;
}

export interface IdempotencyStore {
  /** 超过 ttlMs 的记录可被清理（T8.2 留存策略） */
  begin<T>(key: string): Promise<IdempotencyTicket<T>>;
  purge(olderThanMs: number): Promise<number>;
  count(): number;
}

export interface SqliteIdempotencyStoreOptions {
  path?: string;
  ttlMs?: number;
  clock?: () => number;
}

/** 落盘幂等存储（better-sqlite3） */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private readonly db: Database.Database;
  private readonly pending = new Set<string>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: SqliteIdempotencyStoreOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.clock = options.clock ?? Date.now;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS idempotency (
         key TEXT PRIMARY KEY,
         result TEXT NOT NULL,
         at INTEGER NOT NULL
       )`,
    );
  }

  async begin<T>(key: string): Promise<IdempotencyTicket<T>> {
    const row = this.db
      .prepare(`SELECT result, at FROM idempotency WHERE key = ?`)
      .get(key) as { result: string; at: number } | undefined;

    if (row) {
      const result = JSON.parse(row.result) as T;
      return { hit: true, result, commit: async () => {}, rollback: async () => {} };
    }
    if (this.pending.has(key)) {
      return { hit: true, commit: async () => {}, rollback: async () => {} };
    }

    this.pending.add(key);
    return {
      hit: false,
      commit: async (result: T) => {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO idempotency (key, result, at) VALUES (?, ?, ?)`,
          )
          .run(key, JSON.stringify(result ?? null), this.clock());
        this.pending.delete(key);
      },
      rollback: async () => {
        this.pending.delete(key);
      },
    };
  }

  async purge(olderThanMs: number): Promise<number> {
    const cutoff = this.clock() - olderThanMs;
    const res = this.db
      .prepare(`DELETE FROM idempotency WHERE at < ?`)
      .run(cutoff);
    return res.changes;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM idempotency`).get() as {
      n: number;
    };
    return row.n;
  }

  /** ttl 到期清理（T8.2） */
  async purgeExpired(): Promise<number> {
    return this.purge(this.ttlMs);
  }

  close(): void {
    this.db.close();
  }
}

/** 进程内幂等存储：测试与单进程开发用 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, { result: string; at: number }>();
  private readonly pending = new Set<string>();

  async begin<T>(key: string): Promise<IdempotencyTicket<T>> {
    const existing = this.map.get(key);
    if (existing) {
      return {
        hit: true,
        result: JSON.parse(existing.result) as T,
        commit: async () => {},
        rollback: async () => {},
      };
    }
    if (this.pending.has(key)) {
      return { hit: true, commit: async () => {}, rollback: async () => {} };
    }
    this.pending.add(key);
    return {
      hit: false,
      commit: async (result: T) => {
        this.map.set(key, { result: JSON.stringify(result ?? null), at: Date.now() });
        this.pending.delete(key);
      },
      rollback: async () => {
        this.pending.delete(key);
      },
    };
  }

  async purge(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [key, v] of this.map) {
      if (v.at < cutoff) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  count(): number {
    return this.map.size;
  }
}
