import pg from "pg";
import type { StructuredAuditEvent } from "./events.js";
import { InMemoryAuditStore } from "./store.js";
import type { AuditQuery, AuditStore } from "./store.js";

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id SERIAL PRIMARY KEY,
    event TEXT NOT NULL,
    request_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    session_id TEXT,
    data_source_id TEXT,
    duration_ms INTEGER,
    row_count INTEGER,
    failure_kind TEXT,
    metadata_json TEXT,
    timestamp TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts
    ON audit_events(tenant_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_tenant_subject
    ON audit_events(tenant_id, subject_id);
`;

function rowToEvent(row: Record<string, unknown>): StructuredAuditEvent {
  const metadataRaw = row.metadata_json;
  let metadata: Record<string, unknown> | undefined;
  if (typeof metadataRaw === "string" && metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  }
  const ts = row.timestamp;
  const timestamp =
    ts instanceof Date
      ? ts.toISOString()
      : typeof ts === "string"
        ? ts
        : new Date().toISOString();

  return {
    event: String(row.event) as StructuredAuditEvent["event"],
    requestId: String(row.request_id),
    traceId: String(row.trace_id),
    subjectId: String(row.subject_id),
    tenantId: String(row.tenant_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    dataSourceId: row.data_source_id ? String(row.data_source_id) : undefined,
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined
        ? undefined
        : Number(row.duration_ms),
    rowCount:
      row.row_count === null || row.row_count === undefined
        ? undefined
        : Number(row.row_count),
    failureKind: row.failure_kind ? String(row.failure_kind) : undefined,
    metadata,
    timestamp,
  };
}

export interface PostgresAuditStoreOptions {
  /** 连接串；缺省时使用 Docker 联调默认 */
  connectionString?: string;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

/**
 * PostgreSQL 审计持久化：quasi-production / staging 适配器。
 * append 双写 PG + 内存索引；query 走内存以满足 AuditStore 同步合约（PG 为权威落库）。
 */
export class PostgresAuditStore implements AuditStore {
  private readonly pool: pg.Pool;
  private readonly memory = new InMemoryAuditStore();
  private readonly pending = new Set<Promise<void>>();
  private readonly backgroundErrors: unknown[] = [];
  private readonly onBackgroundError: (operation: string, error: unknown) => void;
  private schemaReady: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: PostgresAuditStoreOptions = {}) {
    const connectionString =
      options.connectionString ?? resolveDefaultAuditConnectionString();
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
    });
    this.onBackgroundError =
      options.onBackgroundError ??
      ((operation, error) => {
        console.error(`[bi-analyst] audit ${operation} failed`, error);
      });
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      const ready = this.pool.query(INIT_SQL).then(() => undefined);
      this.schemaReady = ready;
      void ready.catch(() => {
        if (this.schemaReady === ready) this.schemaReady = null;
      });
    }
    await this.schemaReady;
  }

  private enqueue(operation: string, task: Promise<void>): void {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      (error) => {
        this.pending.delete(task);
        this.backgroundErrors.push(error);
        this.onBackgroundError(operation, error);
      },
    );
  }

  async flush(): Promise<void> {
    const snapshot = [...this.pending];
    if (snapshot.length > 0) await Promise.allSettled(snapshot);
    if (this.backgroundErrors.length > 0) {
      const errors = this.backgroundErrors.splice(0);
      throw new AggregateError(errors, "Audit persistence failed");
    }
  }

  append(event: StructuredAuditEvent): void {
    this.memory.append(event);
    this.enqueue("append", this.persistAsync(event));
  }

  async appendAsync(event: StructuredAuditEvent): Promise<void> {
    // Keep the synchronous AuditStore view consistent for callers that await
    // the async persistence API directly (for example, contract checks and
    // administrative workflows).
    this.memory.append(event);
    await this.persistAsync(event);
  }

  private async persistAsync(event: StructuredAuditEvent): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO audit_events (
        event, request_id, trace_id, subject_id, tenant_id,
        session_id, data_source_id, duration_ms, row_count,
        failure_kind, metadata_json, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.event,
        event.requestId,
        event.traceId,
        event.subjectId,
        event.tenantId,
        event.sessionId ?? null,
        event.dataSourceId ?? null,
        event.durationMs ?? null,
        event.rowCount ?? null,
        event.failureKind ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.timestamp,
      ],
    );
  }

  query(filter: AuditQuery): StructuredAuditEvent[] {
    return this.memory.query(filter);
  }

  async queryAsync(filter: AuditQuery): Promise<StructuredAuditEvent[]> {
    await this.flush();
    await this.ensureSchema();
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
    const offset = Math.max(0, filter.offset ?? 0);
    const since = filter.sinceMs ? Date.now() - filter.sinceMs : 0;

    const clauses = ["tenant_id = $1"];
    const params: unknown[] = [filter.tenantId];
    let idx = 2;

    if (filter.subjectId) {
      clauses.push(`subject_id = $${idx++}`);
      params.push(filter.subjectId);
    }
    if (filter.requestId) {
      clauses.push(`request_id = $${idx++}`);
      params.push(filter.requestId);
    }
    if (filter.event) {
      clauses.push(`event = $${idx++}`);
      params.push(filter.event);
    }
    if (since > 0) {
      clauses.push(`timestamp >= $${idx++}`);
      params.push(new Date(since).toISOString());
    }

    params.push(limit, offset);
    const sql = `
      SELECT * FROM audit_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC, id DESC
      LIMIT $${idx++} OFFSET $${idx}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) =>
      rowToEvent(row as Record<string, unknown>),
    );
  }

  queryFromDatabase(filter: AuditQuery): Promise<StructuredAuditEvent[]> {
    return this.queryAsync(filter);
  }

  purgeOlderThan(retentionMs: number): number {
    const removed = this.memory.purgeOlderThan(retentionMs);
    this.enqueue(
      "retention purge",
      this.purgeDatabase(retentionMs).then(() => undefined),
    );
    return removed;
  }

  async purgeOlderThanAsync(retentionMs: number): Promise<number> {
    await this.flush();
    const memoryRemoved = this.memory.purgeOlderThan(retentionMs);
    const databaseRemoved = await this.purgeDatabase(retentionMs);
    return Math.max(databaseRemoved, memoryRemoved);
  }

  private async purgeDatabase(retentionMs: number): Promise<number> {
    await this.ensureSchema();
    if (retentionMs <= 0) {
      const result = await this.pool.query(`DELETE FROM audit_events`);
      return result.rowCount ?? 0;
    }
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const result = await this.pool.query(
      `DELETE FROM audit_events WHERE timestamp < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  size(): number {
    return this.memory.size();
  }

  async sizeAsync(): Promise<number> {
    await this.flush();
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM audit_events`,
    );
    return Number(result.rows[0]?.c ?? 0);
  }

  sizeInDatabase(): Promise<number> {
    return this.sizeAsync();
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.ensureSchema();
      await this.pool.query("SELECT 1");
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        let flushError: unknown;
        try {
          await this.flush();
        } catch (error) {
          flushError = error;
        }
        await this.pool.end();
        if (flushError) throw flushError;
      })();
    }
    await this.closePromise;
  }
}

function resolveDefaultAuditConnectionString(): string {
  return resolvePostgresAuditConnectionFromEnv();
}

export function resolvePostgresAuditConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.AUDIT_DATABASE_URL) return env.AUDIT_DATABASE_URL;
  const host = env.BI_PG_HOST ?? "127.0.0.1";
  const port = env.BI_PG_PORT ?? "5432";
  const user = env.BI_PG_USER ?? "bi";
  const password = env.BI_PG_PASSWORD ?? "bi_dev";
  const database = env.BI_PG_DATABASE ?? "retail";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}
