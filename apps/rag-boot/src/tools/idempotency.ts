import {
  LeaseLostError, OperationInProgressError, MemoryLeaseStore, SqliteLeaseStore,
  type LeaseStore,
} from "../reliability/lease-store";

export interface IdempotencyTicket<T> {
  hit: boolean;
  result?: T;
  leaseMs?: number;
  renew?(): Promise<void>;
  commit(result: T): Promise<void>;
  rollback?(): Promise<void>;
}

export interface IdempotencyStore {
  readonly durable?: boolean;
  begin<T>(key: string): Promise<IdempotencyTicket<T>>;
  purge(olderThanMs: number): Promise<number>;
  count(): number;
}

export interface SqliteIdempotencyStoreOptions {
  path?: string;
  ttlMs?: number;
  leaseMs?: number;
  clock?: () => number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly durable: boolean;
  private readonly clock: () => number;
  private readonly leaseMs: number;
  protected readonly ttlMs: number;

  constructor(
    options: SqliteIdempotencyStoreOptions = {},
    protected readonly store: LeaseStore = new MemoryLeaseStore(),
  ) {
    this.durable = store.durable;
    this.clock = options.clock ?? Date.now;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (this.leaseMs <= 0) throw new Error("leaseMs must be positive");
  }

  async begin<T>(key: string): Promise<IdempotencyTicket<T>> {
    const claim = this.store.claim(key, key, this.clock(), this.leaseMs);
    if (claim.status === "completed") {
      return { hit: true, result: claim.result as T, commit: async () => {} };
    }
    if (claim.status !== "acquired") throw new OperationInProgressError(key);
    return {
      hit: false,
      leaseMs: this.leaseMs,
      renew: async () => {
        if (!this.store.renew(key, claim.owner, this.clock(), this.leaseMs)) throw new LeaseLostError();
      },
      commit: async (result: T) => {
        if (!this.store.complete(key, claim.owner, result, this.clock())) throw new LeaseLostError();
      },
      rollback: async () => { this.store.fail(key, claim.owner, this.clock()); },
    };
  }

  async purge(olderThanMs: number): Promise<number> {
    return this.store.purge(this.clock() - olderThanMs);
  }
  count(): number { return this.store.count(); }
}

export class SqliteIdempotencyStore extends InMemoryIdempotencyStore {
  private readonly sqlite: SqliteLeaseStore;
  constructor(options: SqliteIdempotencyStoreOptions = {}) {
    const sqlite = new SqliteLeaseStore(options.path ?? ":memory:", "tools");
    super(options, sqlite);
    this.sqlite = sqlite;
  }
  async purgeExpired(): Promise<number> { return this.purge(this.ttlMs); }
  close(): void { this.sqlite.close(); }
}
