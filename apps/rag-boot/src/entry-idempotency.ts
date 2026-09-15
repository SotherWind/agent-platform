import {
  MemoryLeaseStore, SqliteLeaseStore,
  type LeaseStore, type LeaseClaim,
} from "./reliability/lease-store";

export interface EntryIdempotencyStoreLike {
  readonly durable: boolean;
  readonly leaseMs: number;
  claim(messageId: string, fingerprint: string): LeaseClaim;
  renew(messageId: string, owner: string): boolean;
  complete(messageId: string, owner: string, result: unknown): boolean;
  fail(messageId: string, owner: string): boolean;
  /** @deprecated Use claim/complete/fail for recoverable processing. */
  first(messageId: string): boolean;
}

export interface EntryIdempotencyStoreOptions {
  ttlMs?: number;
  leaseMs?: number;
  clock?: () => number;
}

export class EntryIdempotencyStore implements EntryIdempotencyStoreLike {
  readonly durable: boolean;
  readonly leaseMs: number;
  private readonly clock: () => number;
  private readonly ttlMs: number;

  constructor(
    opts: EntryIdempotencyStoreOptions = {},
    protected readonly store: LeaseStore = new MemoryLeaseStore(),
  ) {
    this.clock = opts.clock ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.leaseMs = opts.leaseMs ?? 60_000;
    if (this.leaseMs <= 0) throw new Error("leaseMs must be positive");
    this.durable = store.durable;
  }

  claim(messageId: string, fingerprint: string): LeaseClaim {
    this.store.purge(this.clock() - this.ttlMs);
    return this.store.claim(messageId, fingerprint, this.clock(), this.leaseMs);
  }
  renew(messageId: string, owner: string): boolean {
    return this.store.renew(messageId, owner, this.clock(), this.leaseMs);
  }
  complete(messageId: string, owner: string, result: unknown): boolean {
    return this.store.complete(messageId, owner, result, this.clock());
  }
  fail(messageId: string, owner: string): boolean {
    return this.store.fail(messageId, owner, this.clock());
  }
  first(messageId: string): boolean {
    return this.claim(messageId, messageId).status === "acquired";
  }
}

export interface SqliteEntryIdempotencyStoreOptions extends EntryIdempotencyStoreOptions {
  path?: string;
}

export class SqliteEntryIdempotencyStore extends EntryIdempotencyStore {
  private readonly sqlite: SqliteLeaseStore;
  constructor(opts: SqliteEntryIdempotencyStoreOptions = {}) {
    const sqlite = new SqliteLeaseStore(opts.path ?? ":memory:", "entry");
    super(opts, sqlite);
    this.sqlite = sqlite;
  }
  close(): void { this.sqlite.close(); }
}

export const SQLiteEntryIdempotencyStore = SqliteEntryIdempotencyStore;
