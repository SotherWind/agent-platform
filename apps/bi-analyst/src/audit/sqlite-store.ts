import type Database from "better-sqlite3";
import type { StructuredAuditEvent } from "./events.js";
import type { AuditQuery, AuditStore } from "./store.js";

function initAuditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts
      ON audit_events(tenant_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_tenant_subject
      ON audit_events(tenant_id, subject_id);
  `);
}

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
    timestamp: String(row.timestamp),
  };
}

/** SQLite 审计持久化：development 单源闭环；生产可共用同一接口 */
export class SqliteAuditStore implements AuditStore {
  private readonly insertStmt;

  constructor(private readonly db: Database.Database) {
    initAuditSchema(db);
    this.insertStmt = db.prepare(`
      INSERT INTO audit_events (
        event, request_id, trace_id, subject_id, tenant_id,
        session_id, data_source_id, duration_ms, row_count,
        failure_kind, metadata_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  append(event: StructuredAuditEvent): void {
    this.insertStmt.run(
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
    );
  }

  query(filter: AuditQuery): StructuredAuditEvent[] {
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
    const offset = Math.max(0, filter.offset ?? 0);
    const since = filter.sinceMs ? Date.now() - filter.sinceMs : 0;

    const clauses = ["tenant_id = ?"];
    const params: unknown[] = [filter.tenantId];

    if (filter.subjectId) {
      clauses.push("subject_id = ?");
      params.push(filter.subjectId);
    }
    if (filter.requestId) {
      clauses.push("request_id = ?");
      params.push(filter.requestId);
    }
    if (filter.event) {
      clauses.push("event = ?");
      params.push(filter.event);
    }
    if (since > 0) {
      clauses.push("timestamp >= ?");
      params.push(new Date(since).toISOString());
    }

    params.push(limit, offset);
    const sql = `
      SELECT * FROM audit_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToEvent);
  }

  purgeOlderThan(retentionMs: number): number {
    if (retentionMs <= 0) {
      const result = this.db.prepare(`DELETE FROM audit_events`).run();
      return result.changes;
    }
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const result = this.db
      .prepare(`DELETE FROM audit_events WHERE timestamp < ?`)
      .run(cutoff);
    return result.changes;
  }

  size(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events`)
      .get() as { c: number };
    return Number(row.c);
  }
}
