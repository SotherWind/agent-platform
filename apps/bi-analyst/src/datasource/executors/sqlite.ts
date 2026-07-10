import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ExecutionResult } from "../../entities.js";
import { auditLog } from "../../audit/logger.js";
import {
  classifySqlError,
  sanitizeSqlError,
  type SqlFailureKind,
} from "../../errors/sql-failure.js";
import { validateSql } from "../sql-validator.js";
import type {
  HealthStatus,
  SqlExecutionRequest,
  SqlExecutor,
} from "../types.js";

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sqlite-worker.js",
);

export interface SqliteExecutorOptions {
  db: Database.Database;
  dataSourceId: string;
  maxRows?: number;
  allowedTables?: string[];
}

interface WorkerResult {
  rows: Record<string, unknown>[];
  columns: string[];
  durationMs: number;
  error?: string;
}

/** SQLite SqlExecutor：校验 → 超时 Worker 执行 → 审计脱敏 */
export class SqliteExecutor implements SqlExecutor {
  private readonly maxRows: number;
  private readonly allowedTables?: string[];

  constructor(private readonly options: SqliteExecutorOptions) {
    this.maxRows = options.maxRows ?? 10_000;
    this.allowedTables = options.allowedTables;
  }

  async execute(
    request: SqlExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const validation = validateSql(request.sql, {
      dialectFamily: "sqlite",
      maxRows: request.maxRows ?? this.maxRows,
      allowedTables: this.allowedTables,
    });

    if (!validation.valid) {
      const sanitized = sanitizeSqlError(
        validation.reason ?? "policy_rejected",
        "policy_rejected",
      );
      auditLog({
        requestId: request.requestId ?? crypto.randomUUID(),
        subjectId: request.subjectId ?? "unknown",
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        dataSourceId: request.dataSourceId,
        sql: request.sql,
        durationMs: Date.now() - startTime,
        failureKind: sanitized.kind,
        rawError: validation.reason,
      });
      return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
    }

    const sql = validation.normalizedSql!;

    if (signal.aborted) {
      return emptyErrorResult("timeout", "查询已取消");
    }

    try {
      const workerResult =
        process.env.BI_SQLITE_SYNC === "1"
          ? executeSqliteSync(this.options.db, sql)
          : await runInWorker(
              this.options.db.name ?? ":memory:",
              sql,
              request.timeoutMs,
              signal,
            );

      if (workerResult.error) {
        const sanitized = sanitizeSqlError(workerResult.error);
        auditLog({
          requestId: request.requestId ?? crypto.randomUUID(),
          subjectId: request.subjectId ?? "unknown",
          tenantId: request.tenantId,
          sessionId: request.sessionId,
          dataSourceId: request.dataSourceId,
          sql,
          durationMs: workerResult.durationMs,
          rowCount: 0,
          failureKind: sanitized.kind,
          rawError: workerResult.error,
        });
        return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
      }

      const { rows, columns } = workerResult;
      auditLog({
        requestId: request.requestId ?? crypto.randomUUID(),
        subjectId: request.subjectId ?? "unknown",
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        dataSourceId: request.dataSourceId,
        sql,
        durationMs: workerResult.durationMs,
        rowCount: rows.length,
      });

      if (rows.length === 0) {
        return {
          rows: [],
          columns: [],
          isEmpty: true,
          stats: { durationMs: workerResult.durationMs, rowCount: 0 },
        };
      }

      return {
        rows,
        columns,
        isEmpty: false,
        stats: { durationMs: workerResult.durationMs, rowCount: rows.length },
      };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const kind: SqlFailureKind = /timeout|cancel/i.test(raw)
        ? "timeout"
        : classifySqlError(raw);
      const sanitized = sanitizeSqlError(raw, kind);
      auditLog({
        requestId: request.requestId ?? crypto.randomUUID(),
        subjectId: request.subjectId ?? "unknown",
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        dataSourceId: request.dataSourceId,
        sql,
        durationMs: Date.now() - startTime,
        failureKind: sanitized.kind,
        rawError: raw,
      });
      return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      this.options.db.prepare("SELECT 1").get();
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  async close(): Promise<void> {
    this.options.db.close();
  }
}

function emptyErrorResult(
  failureKind: SqlFailureKind,
  safeMessage: string,
): ExecutionResult {
  return {
    rows: [],
    columns: [],
    isEmpty: true,
    error: safeMessage,
    failureKind,
  };
}

/** 在 Worker 中执行 SQL，超时后 terminate 实现取消 */
function runInWorker(
  dbPath: string,
  sql: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { dbPath, sql },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(() => reject(new Error("Query timeout")));
    }, timeoutMs);

    const onAbort = () => {
      worker.terminate().catch(() => {});
      finish(() => reject(new Error("Query cancelled")));
    };
    signal.addEventListener("abort", onAbort);

    worker.on("message", (msg: WorkerResult) => {
      worker.terminate().catch(() => {});
      finish(() => resolve(msg));
    });

    worker.on("error", (err) => {
      worker.terminate().catch(() => {});
      finish(() => reject(err));
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Worker exited with code ${code}`)));
      }
    });
  });
}

/** 同步执行路径（测试/无 Worker 场景） */
export function executeSqliteSync(
  db: Database.Database,
  sql: string,
): WorkerResult {
  const start = Date.now();
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    const columns =
      rows.length > 0 ? Object.keys(rows[0] as object) : [];
    return { rows, columns, durationMs: Date.now() - start };
  } catch (err) {
    return {
      rows: [],
      columns: [],
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
