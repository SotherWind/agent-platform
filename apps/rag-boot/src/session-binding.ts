import Database from "better-sqlite3";
import { AuthenticationContextError } from "./errors";
import { MemoryLeaseStore, SqliteLeaseStore, LeaseLostError, OperationInProgressError, type LeaseStore } from "./reliability/lease-store";

export interface SessionIdentity {
  tenantId: string;
  principal: string;
  threadId: string;
  authorizationScope?: string;
}

export interface SessionBindingStore {
  readonly durable: boolean;
  bind(identity: SessionIdentity): void;
  run<T>(threadId: string, work: () => Promise<T>): Promise<T>;
}

async function runSession<T>(leases: LeaseStore, threadId: string, work: () => Promise<T>): Promise<T> {
  const leaseMs = 60_000;
  const claim = leases.claim(threadId, threadId, Date.now(), leaseMs);
  if (claim.status !== "acquired") throw new OperationInProgressError(threadId);
  let lost = false;
  const timer = setInterval(() => {
    try { lost ||= !leases.renew(threadId, claim.owner, Date.now(), leaseMs); }
    catch { lost = true; }
  }, leaseMs / 3);
  timer.unref();
  try {
    const result = await work();
    if (lost || !leases.renew(threadId, claim.owner, Date.now(), leaseMs)) throw new LeaseLostError();
    return result;
  } finally {
    clearInterval(timer);
    leases.fail(threadId, claim.owner, Date.now());
  }
}

function assertOwner(existing: Omit<SessionIdentity, "threadId">, next: SessionIdentity): void {
  if (existing.tenantId !== next.tenantId || existing.principal !== next.principal ||
      (existing.authorizationScope ?? "") !== (next.authorizationScope ?? "")) {
    throw new AuthenticationContextError("The session belongs to a different identity.", {
      reasonCode: "session_owner_mismatch",
    });
  }
}

export class MemorySessionBindingStore implements SessionBindingStore {
  readonly durable = false;
  private readonly owners = new Map<string, SessionIdentity>();
  private readonly leases = new MemoryLeaseStore();
  run<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return runSession(this.leases, threadId, work);
  }
  bind(identity: SessionIdentity): void {
    const existing = this.owners.get(identity.threadId);
    if (existing) assertOwner(existing, identity);
    else this.owners.set(identity.threadId, { ...identity });
  }
}

export class SqliteSessionBindingStore implements SessionBindingStore {
  readonly durable: boolean;
  private readonly db: Database.Database;
  private readonly leases: SqliteLeaseStore;
  constructor(path: string) {
    this.durable = path !== ":memory:" && path !== "";
    this.db = new Database(path);
    this.leases = new SqliteLeaseStore(path, "session-execution");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_bindings (
      thread_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
      authorization_scope TEXT NOT NULL DEFAULT ''
    )`);
    const columns = this.db.pragma("table_info(session_bindings)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "authorization_scope")) {
      this.db.exec("ALTER TABLE session_bindings ADD COLUMN authorization_scope TEXT NOT NULL DEFAULT ''");
    }
  }
  bind(identity: SessionIdentity): void {
    this.db.prepare(`INSERT OR IGNORE INTO session_bindings
      (thread_id, tenant_id, principal, authorization_scope) VALUES (?, ?, ?, ?)`)
      .run(identity.threadId, identity.tenantId, identity.principal, identity.authorizationScope ?? "");
    const owner = this.db.prepare(`SELECT tenant_id AS tenantId, principal,
      authorization_scope AS authorizationScope FROM session_bindings WHERE thread_id = ?`)
      .get(identity.threadId) as SessionIdentity;
    assertOwner(owner, identity);
  }
  run<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return runSession(this.leases, threadId, work);
  }
  close(): void { this.leases.close(); this.db.close(); }
}
