import type Database from "better-sqlite3";

import type {

  QueryHistoryListOptions,

  QueryHistoryRecord,

  QueryHistoryStore,

} from "./store.js";



function initHistorySchema(db: Database.Database): void {

  db.exec(`

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

      needs_clarification INTEGER NOT NULL DEFAULT 0,

      created_at TEXT NOT NULL,

      duration_ms INTEGER,

      rows_json TEXT,

      columns_json TEXT

    );

    CREATE INDEX IF NOT EXISTS idx_history_tenant_subject_ts

      ON query_history(tenant_id, subject_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_history_request

      ON query_history(tenant_id, subject_id, request_id);

  `);

}



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



function rowToRecord(row: Record<string, unknown>): QueryHistoryRecord {

  let rows: Record<string, unknown>[] | undefined;

  let columns: string[] | undefined;

  const rowsRaw = row.rows_json;

  const colsRaw = row.columns_json;

  if (typeof rowsRaw === "string" && rowsRaw) {

    try {

      rows = JSON.parse(rowsRaw) as Record<string, unknown>[];

    } catch {

      rows = undefined;

    }

  }

  if (typeof colsRaw === "string" && colsRaw) {

    try {

      columns = JSON.parse(colsRaw) as string[];

    } catch {

      columns = undefined;

    }

  }



  return {

    id: String(row.id),

    tenantId: String(row.tenant_id),

    subjectId: String(row.subject_id),

    sessionId: row.session_id ? String(row.session_id) : undefined,

    requestId: String(row.request_id),

    traceId: String(row.trace_id),

    query: String(row.query),

    finalAnswerPreview: String(row.final_answer_preview),

    queryPath: row.query_path ? String(row.query_path) : null,

    dataSourceId: row.data_source_id ? String(row.data_source_id) : undefined,

    needsClarification: Boolean(row.needs_clarification),

    createdAt: String(row.created_at),

    durationMs:

      row.duration_ms === null || row.duration_ms === undefined

        ? undefined

        : Number(row.duration_ms),

    rows,

    columns,

  };

}



/** SQLite 查询历史持久化：development 单源闭环；与 SqliteAuditStore 对称 */

export class SqliteQueryHistoryStore implements QueryHistoryStore {

  private readonly insertStmt;



  constructor(private readonly db: Database.Database) {

    initHistorySchema(db);

    this.insertStmt = db.prepare(`

      INSERT OR REPLACE INTO query_history (

        id, tenant_id, subject_id, session_id, request_id, trace_id,

        query, final_answer_preview, query_path, data_source_id,

        needs_clarification, created_at, duration_ms, rows_json, columns_json

      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

    `);

  }



  append(record: QueryHistoryRecord): void {

    this.insertStmt.run(

      record.id,

      record.tenantId,

      record.subjectId,

      record.sessionId ?? null,

      record.requestId,

      record.traceId,

      record.query,

      record.finalAnswerPreview,

      record.queryPath,

      record.dataSourceId ?? null,

      record.needsClarification ? 1 : 0,

      record.createdAt,

      record.durationMs ?? null,

      record.rows ? JSON.stringify(record.rows) : null,

      record.columns ? JSON.stringify(record.columns) : null,

    );

  }



  list(

    tenantId: string,

    subjectId: string,

    options?: number | QueryHistoryListOptions,

  ): QueryHistoryRecord[] {

    const { limit, offset, minDurationMs } = normalizeListOptions(options);

    const safeLimit = Math.min(Math.max(1, limit), 100);



    const clauses = ["tenant_id = ?", "subject_id = ?"];

    const params: unknown[] = [tenantId, subjectId];

    if (minDurationMs !== undefined) {

      clauses.push("duration_ms >= ?");

      params.push(minDurationMs);

    }



    params.push(safeLimit + offset);

    const sql = `

      SELECT * FROM query_history

      WHERE ${clauses.join(" AND ")}

      ORDER BY created_at DESC, id DESC

      LIMIT ?

    `;

    const rows = this.db.prepare(sql).all(...params) as Record<

      string,

      unknown

    >[];

    return rows

      .slice(offset, offset + safeLimit)

      .map((row) => {

        const { rows: _rows, columns: _cols, ...safe } = rowToRecord(row);

        return safe;

      });

  }



  getByRequestId(

    tenantId: string,

    subjectId: string,

    requestId: string,

  ): QueryHistoryRecord | undefined {

    const row = this.db

      .prepare(

        `SELECT * FROM query_history

         WHERE tenant_id = ? AND subject_id = ? AND request_id = ?

         ORDER BY created_at DESC LIMIT 1`,

      )

      .get(tenantId, subjectId, requestId) as Record<string, unknown> | undefined;

    return row ? rowToRecord(row) : undefined;

  }



  size(): number {

    const row = this.db

      .prepare(`SELECT COUNT(*) AS c FROM query_history`)

      .get() as { c: number };

    return Number(row.c);

  }

}


