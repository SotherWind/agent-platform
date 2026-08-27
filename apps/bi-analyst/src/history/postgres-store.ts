import pg from "pg";
import { InMemoryQueryHistoryStore } from "./store.js";
import type {
  QueryHistoryListOptions,
  QueryHistoryRecord,
  QueryHistoryStore,
} from "./store.js";
import { resolvePostgresAuditConnectionFromEnv } from "../audit/postgres-store.js";
import {
  decryptExportPayload,
  encryptExportPayload,
} from "../export/encrypt.js";

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS query_history (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    session_id TEXT,
    request_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    query TEXT NOT NULL,
    final_answer_preview TEXT NOT NULL,
    query_path TEXT,
    data_source_id TEXT,
    needs_clarification BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER,
    rows_json TEXT,
    columns_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pg_history_tenant_subject_ts
    ON query_history(tenant_id, subject_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pg_history_request
    ON query_history(tenant_id, subject_id, request_id);
`;

function normalizeListOptions(
  options?: number | QueryHistoryListOptions,
): Required<Pick<QueryHistoryListOptions, "limit" | "offset">> &
  Pick<QueryHistoryListOptions, "minDurationMs"> {
  if (typeof options === "number") {
    return { limit: options, offset: 0 };
  }
  return {
    limit: options?.limit ?? 20,
    offset: Math.max(0, options?.offset ?? 0),
    minDurationMs: options?.minDurationMs,
  };
}

function decodeStored(value: unknown, secret?: string): string {
  const text = String(value ?? "");
  if (!secret || !text.startsWith("enc:v1:")) return text;
  return decryptExportPayload(text.slice("enc:v1:".length), secret);
}

function encodeStored(value: string, secret?: string): string {
  return secret ? `enc:v1:${encryptExportPayload(value, secret)}` : value;
}

function rowToRecord(
  row: Record<string, unknown>,
  encryptionSecret?: string,
): QueryHistoryRecord {
  let rows: Record<string, unknown>[] | undefined;
  let columns: string[] | undefined;
  const rowsRaw = row.rows_json;
  const colsRaw = row.columns_json;
  if (typeof rowsRaw === "string" && rowsRaw) {
    try {
      rows = JSON.parse(decodeStored(rowsRaw, encryptionSecret)) as Record<string, unknown>[];
    } catch {
      rows = undefined;
    }
  }
  if (typeof colsRaw === "string" && colsRaw) {
    try {
      columns = JSON.parse(decodeStored(colsRaw, encryptionSecret)) as string[];
    } catch {
      columns = undefined;
    }
  }

  const createdAtRaw = row.created_at;
  const createdAt =
    createdAtRaw instanceof Date
      ? createdAtRaw.toISOString()
      : String(createdAtRaw ?? new Date().toISOString());

  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    subjectId: String(row.subject_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    requestId: String(row.request_id),
    traceId: String(row.trace_id),
    query: decodeStored(row.query, encryptionSecret),
    finalAnswerPreview: decodeStored(row.final_answer_preview, encryptionSecret),
    queryPath: row.query_path ? String(row.query_path) : null,
    dataSourceId: row.data_source_id ? String(row.data_source_id) : undefined,
    needsClarification: Boolean(row.needs_clarification),
    createdAt,
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined
        ? undefined
        : Number(row.duration_ms),
    rows,
    columns,
  };
}

export interface PostgresQueryHistoryStoreOptions {
  connectionString?: string;
  encryptionSecret?: string;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

/**
 * PostgreSQL 查询历史：quasi-production / staging。
 * append 双写 PG + 内存；list/get 走内存以满足同步合约（PG 为权威落库）。
 */
export class PostgresQueryHistoryStore implements QueryHistoryStore {
  private readonly pool: pg.Pool;
  private readonly memory = new InMemoryQueryHistoryStore();
  private readonly pending = new Set<Promise<void>>();
  private readonly backgroundErrors: unknown[] = [];
  private readonly onBackgroundError: (operation: string, error: unknown) => void;
  private schemaReady: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly encryptionSecret?: string;

  constructor(options: PostgresQueryHistoryStoreOptions = {}) {
    const connectionString =
      options.connectionString ?? resolveHistoryConnectionFromEnv();
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
    });
    this.encryptionSecret = options.encryptionSecret;
    this.onBackgroundError =
      options.onBackgroundError ??
      ((operation, error) => {
        console.error(`[bi-analyst] history ${operation} failed`, error);
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
      throw new AggregateError(errors, "Query history persistence failed");
    }
  }

  append(record: QueryHistoryRecord): void {
    this.memory.append(record);
    this.enqueue("append", this.persistAsync(record));
  }

  async appendAsync(record: QueryHistoryRecord): Promise<void> {
    this.memory.append(record);
    await this.persistAsync(record);
  }

  private async persistAsync(record: QueryHistoryRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO query_history (
        id, tenant_id, subject_id, session_id, request_id, trace_id,
        query, final_answer_preview, query_path, data_source_id,
        needs_clarification, created_at, duration_ms, rows_json, columns_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        final_answer_preview = EXCLUDED.final_answer_preview,
        query_path = EXCLUDED.query_path,
        duration_ms = EXCLUDED.duration_ms,
        rows_json = EXCLUDED.rows_json,
        columns_json = EXCLUDED.columns_json`,
      [
        record.id,
        record.tenantId,
        record.subjectId,
        record.sessionId ?? null,
        record.requestId,
        record.traceId,
        encodeStored(record.query, this.encryptionSecret),
        encodeStored(record.finalAnswerPreview, this.encryptionSecret),
        record.queryPath,
        record.dataSourceId ?? null,
        record.needsClarification,
        record.createdAt,
        record.durationMs ?? null,
        record.rows
          ? encodeStored(JSON.stringify(record.rows), this.encryptionSecret)
          : null,
        record.columns
          ? encodeStored(JSON.stringify(record.columns), this.encryptionSecret)
          : null,
      ],
    );
  }

  list(
    tenantId: string,
    subjectId: string,
    options?: number | QueryHistoryListOptions,
  ): QueryHistoryRecord[] {
    return this.memory.list(tenantId, subjectId, options);
  }

  getByRequestId(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): QueryHistoryRecord | undefined {
    return this.memory.getByRequestId(tenantId, subjectId, requestId);
  }

  async listAsync(
    tenantId: string,
    subjectId: string,
    options?: number | QueryHistoryListOptions,
  ): Promise<QueryHistoryRecord[]> {
    await this.flush();
    await this.ensureSchema();
    const { limit, offset, minDurationMs } = normalizeListOptions(options);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    const clauses = ["tenant_id = $1", "subject_id = $2"];
    const params: unknown[] = [tenantId, subjectId];
    let idx = 3;
    if (minDurationMs !== undefined) {
      clauses.push(`duration_ms >= $${idx++}`);
      params.push(minDurationMs);
    }
    params.push(safeLimit, offset);
    const sql = `
      SELECT * FROM query_history
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${idx++} OFFSET $${idx}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => {
      const { rows: _rows, columns: _cols, ...safe } = rowToRecord(
        row as Record<string, unknown>,
        this.encryptionSecret,
      );
      return safe;
    });
  }

  listFromDatabase(
    tenantId: string,
    subjectId: string,
    options?: number | QueryHistoryListOptions,
  ): Promise<QueryHistoryRecord[]> {
    return this.listAsync(tenantId, subjectId, options);
  }

  async getByRequestIdAsync(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): Promise<QueryHistoryRecord | undefined> {
    await this.flush();
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT * FROM query_history
       WHERE tenant_id = $1 AND subject_id = $2 AND request_id = $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenantId, subjectId, requestId],
    );
    const row = result.rows[0];
    return row
      ? rowToRecord(row as Record<string, unknown>, this.encryptionSecret)
      : undefined;
  }

  async sizeInDatabase(): Promise<number> {
    await this.flush();
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM query_history`,
    );
    return Number(result.rows[0]?.c ?? 0);
  }

  async purgeAll(): Promise<number> {
    await this.flush();
    await this.ensureSchema();
    const result = await this.pool.query(`DELETE FROM query_history`);
    return result.rowCount ?? 0;
  }

  async purgeOlderThanAsync(
    retentionMs: number,
    now = new Date(),
  ): Promise<number> {
    await this.flush();
    await this.ensureSchema();
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const result = await this.pool.query(
      `DELETE FROM query_history WHERE created_at < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  purgeTenantOlderThan(tenantId: string, retentionMs: number, now = new Date()): number {
    const removed = this.memory.purgeTenantOlderThan(tenantId, retentionMs, now);
    this.enqueue(
      "tenant retention purge",
      this.purgeTenantDatabase(tenantId, retentionMs, now).then(() => undefined),
    );
    return removed;
  }

  async purgeTenantOlderThanAsync(
    tenantId: string,
    retentionMs: number,
    now = new Date(),
  ): Promise<number> {
    await this.flush();
    await this.ensureSchema();
    const memoryRemoved = this.memory.purgeTenantOlderThan(tenantId, retentionMs, now);
    const databaseRemoved = await this.purgeTenantDatabase(tenantId, retentionMs, now);
    return Math.max(memoryRemoved, databaseRemoved);
  }

  private async purgeTenantDatabase(
    tenantId: string,
    retentionMs: number,
    now: Date,
  ): Promise<number> {
    await this.ensureSchema();
    const cutoff = new Date(now.getTime() - Math.max(0, retentionMs)).toISOString();
    const result = await this.pool.query(
      `DELETE FROM query_history WHERE tenant_id = $1 AND created_at < $2`,
      [tenantId, cutoff],
    );
    return result.rowCount ?? 0;
  }

  deleteByRequestId(tenantId: string, subjectId: string, requestId: string): number {
    const removed = this.memory.deleteByRequestId(tenantId, subjectId, requestId);
    this.enqueue(
      "request deletion",
      this.deleteByRequestIdDatabase(tenantId, subjectId, requestId).then(() => undefined),
    );
    return removed;
  }

  async deleteByRequestIdAsync(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): Promise<number> {
    await this.flush();
    await this.ensureSchema();
    const memoryRemoved = this.memory.deleteByRequestId(tenantId, subjectId, requestId);
    const databaseRemoved = await this.deleteByRequestIdDatabase(
      tenantId,
      subjectId,
      requestId,
    );
    return Math.max(memoryRemoved, databaseRemoved);
  }

  private async deleteByRequestIdDatabase(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `DELETE FROM query_history
       WHERE tenant_id = $1 AND subject_id = $2 AND request_id = $3`,
      [tenantId, subjectId, requestId],
    );
    return result.rowCount ?? 0;
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

export function resolveHistoryConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HISTORY_DATABASE_URL) return env.HISTORY_DATABASE_URL;
  return resolvePostgresAuditConnectionFromEnv(env);
}
