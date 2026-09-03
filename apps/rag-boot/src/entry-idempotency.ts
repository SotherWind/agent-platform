/**
 * 入口幂等存储。
 *
 * `first()` 必须是原子操作：并发到达同一个 messageId 时，只有一个调用返回 true。
 * AccessGateway 在限流拒绝后调用 release()，这样客户端可以在稍后重试，而不会把
 * 一次未处理成功的请求永久占成重复投递。
 */
import Database from "better-sqlite3";

export interface EntryIdempotencyStoreLike {
  /** 首次占用返回 true；已占用返回 false。 */
  first(messageId: string): boolean;
  /** 释放尚未被接纳的消息占用。 */
  release?(messageId: string): void;
}

export interface EntryIdempotencyStoreOptions {
  ttlMs?: number;
  clock?: () => number;
}

export class EntryIdempotencyStore implements EntryIdempotencyStoreLike {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: EntryIdempotencyStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.clock = opts.clock ?? Date.now;
  }

  first(messageId: string): boolean {
    const now = this.clock();
    this.evict(now);
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, now);
    return true;
  }

  release(messageId: string): void {
    this.seen.delete(messageId);
  }

  private evict(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key);
    }
  }
}

export interface SqliteEntryIdempotencyStoreOptions extends EntryIdempotencyStoreOptions {
  /** 默认使用内存数据库；生产环境应传入持久化文件路径。 */
  path?: string;
}

/**
 * 基于 better-sqlite3 的 durable 入口幂等存储。
 * SQLite 的唯一键约束保证多个进程/实例同时投递时只有一个 first() 成功。
 */
export class SqliteEntryIdempotencyStore implements EntryIdempotencyStoreLike {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: SqliteEntryIdempotencyStoreOptions = {}) {
    this.db = new Database(opts.path ?? ":memory:");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_idempotency (
        message_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      )
    `);
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.clock = opts.clock ?? Date.now;
  }

  first(messageId: string): boolean {
    const now = this.clock();
    this.evict(now);
    const result = this.db
      .prepare("INSERT OR IGNORE INTO entry_idempotency (message_id, seen_at) VALUES (?, ?)")
      .run(messageId, now);
    return result.changes === 1;
  }

  release(messageId: string): void {
    this.db.prepare("DELETE FROM entry_idempotency WHERE message_id = ?").run(messageId);
  }

  close(): void {
    this.db.close();
  }

  private evict(now: number): void {
    this.db
      .prepare("DELETE FROM entry_idempotency WHERE seen_at < ?")
      .run(now - this.ttlMs);
  }
}

// 保留常见的 SQLite 大写写法，便于调用方按项目命名习惯导入。
export const SQLiteEntryIdempotencyStore = SqliteEntryIdempotencyStore;

