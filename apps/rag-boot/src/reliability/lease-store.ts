import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { AgentError } from "../errors";

export class OperationInProgressError extends AgentError {
  constructor(readonly key: string) {
    super("The operation is still processing; retry with the same key.", {
      stage: "idempotency",
      retryable: true,
    });
  }
}

export class LeaseLostError extends AgentError {
  constructor() {
    super("Operation lease was lost; the stale worker cannot commit.", {
      stage: "idempotency",
      retryable: true,
    });
  }
}

export interface LeaseRecord {
  key: string;
  fingerprint: string;
  status: "processing" | "completed" | "failed";
  owner: string;
  leaseUntil: number;
  updatedAt: number;
  result: unknown;
}

export type LeaseClaim =
  | { status: "acquired"; owner: string }
  | { status: "busy" | "conflict" }
  | { status: "completed"; result: unknown };

export interface LeaseStore {
  readonly durable: boolean;
  claim(key: string, fingerprint: string, now: number, leaseMs: number): LeaseClaim;
  renew(key: string, owner: string, now: number, leaseMs: number): boolean;
  complete(key: string, owner: string, result: unknown, now: number): boolean;
  fail(key: string, owner: string, now: number): boolean;
  get(key: string): LeaseRecord | undefined;
  purge(cutoff: number): number;
  count(): number;
}

function inspect(record: LeaseRecord | undefined, fingerprint: string, now: number): LeaseClaim | null {
  if (!record) return null;
  if (record.fingerprint !== fingerprint) return { status: "conflict" };
  if (record.status === "completed") return { status: "completed", result: record.result };
  if (record.status === "processing" && record.leaseUntil > now) return { status: "busy" };
  return null;
}

export class MemoryLeaseStore implements LeaseStore {
  readonly durable = false;
  private readonly records = new Map<string, LeaseRecord>();

  claim(key: string, fingerprint: string, now: number, leaseMs: number): LeaseClaim {
    const verdict = inspect(this.get(key), fingerprint, now);
    if (verdict) return verdict;
    const owner = randomUUID();
    this.records.set(key, {
      key, fingerprint, owner, status: "processing", leaseUntil: now + leaseMs,
      updatedAt: now, result: null,
    });
    return { status: "acquired", owner };
  }

  private owned(key: string, owner: string, now: number): LeaseRecord | undefined {
    const record = this.records.get(key);
    return record?.status === "processing" && record.owner === owner && record.leaseUntil > now
      ? record : undefined;
  }

  renew(key: string, owner: string, now: number, leaseMs: number): boolean {
    const record = this.owned(key, owner, now);
    if (!record) return false;
    record.leaseUntil = now + leaseMs;
    record.updatedAt = now;
    return true;
  }

  complete(key: string, owner: string, result: unknown, now: number): boolean {
    const record = this.owned(key, owner, now);
    if (!record) return false;
    record.result = structuredClone(result ?? null);
    record.status = "completed";
    record.updatedAt = now;
    return true;
  }

  fail(key: string, owner: string, now: number): boolean {
    const record = this.owned(key, owner, now);
    if (!record) return false;
    record.status = "failed";
    record.updatedAt = now;
    return true;
  }

  get(key: string): LeaseRecord | undefined {
    const record = this.records.get(key);
    return record && structuredClone(record);
  }

  purge(cutoff: number): number {
    let count = 0;
    for (const [key, record] of this.records) {
      if (record.status !== "processing" && record.updatedAt < cutoff) {
        this.records.delete(key);
        count++;
      }
    }
    return count;
  }

  count(): number { return this.records.size; }
}

/** Claims and fenced completions are database transactions, not process-local locks. */
export class SqliteLeaseStore implements LeaseStore {
  readonly durable: boolean;
  private readonly db: Database.Database;

  constructor(path: string, private readonly namespace: string) {
    this.durable = path !== ":memory:" && path !== "";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_leases (
        namespace TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, result TEXT NOT NULL DEFAULT 'null',
        PRIMARY KEY(namespace, key)
      );
    `);
  }

  claim(key: string, fingerprint: string, now: number, leaseMs: number): LeaseClaim {
    return this.db.transaction((): LeaseClaim => {
      const verdict = inspect(this.get(key), fingerprint, now);
      if (verdict) return verdict;
      const owner = randomUUID();
      this.db.prepare(`
        INSERT INTO operation_leases
          (namespace, key, fingerprint, status, owner, lease_until, updated_at)
        VALUES (?, ?, ?, 'processing', ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
          status = 'processing', owner = excluded.owner, lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
      `).run(this.namespace, key, fingerprint, owner, now + leaseMs, now);
      return { status: "acquired", owner };
    }).immediate();
  }

  renew(key: string, owner: string, now: number, leaseMs: number): boolean {
    return this.db.prepare(`
      UPDATE operation_leases SET lease_until = ?, updated_at = ?
      WHERE namespace = ? AND key = ? AND owner = ? AND status = 'processing' AND lease_until > ?
    `).run(now + leaseMs, now, this.namespace, key, owner, now).changes === 1;
  }

  complete(key: string, owner: string, result: unknown, now: number): boolean {
    return this.db.prepare(`
      UPDATE operation_leases SET status = 'completed', result = ?, updated_at = ?
      WHERE namespace = ? AND key = ? AND owner = ? AND status = 'processing' AND lease_until > ?
    `).run(JSON.stringify(result ?? null), now, this.namespace, key, owner, now).changes === 1;
  }

  fail(key: string, owner: string, now: number): boolean {
    return this.db.prepare(`
      UPDATE operation_leases SET status = 'failed', updated_at = ?
      WHERE namespace = ? AND key = ? AND owner = ? AND status = 'processing' AND lease_until > ?
    `).run(now, this.namespace, key, owner, now).changes === 1;
  }

  get(key: string): LeaseRecord | undefined {
    const row = this.db.prepare(`
      SELECT key, fingerprint, status, owner, lease_until AS leaseUntil,
        updated_at AS updatedAt, result FROM operation_leases WHERE namespace = ? AND key = ?
    `).get(this.namespace, key) as (Omit<LeaseRecord, "result"> & { result: string }) | undefined;
    return row && { ...row, result: JSON.parse(row.result) };
  }

  purge(cutoff: number): number {
    return this.db.prepare(`
      DELETE FROM operation_leases WHERE namespace = ? AND status != 'processing' AND updated_at < ?
    `).run(this.namespace, cutoff).changes;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM operation_leases WHERE namespace = ?")
      .get(this.namespace) as { n: number }).n;
  }

  close(): void { this.db.close(); }
}
