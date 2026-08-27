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
import {
  assessExplainQueryPlan,
  explainSqliteQueryPlan,
} from "../explain-cost.js";
import { applyRowFilters } from "../../policy/row-filter-rewrite.js";
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
  allowedColumns?: Record<string, string[]>;
  requireFilterTables?: string[];
  maxJoins?: number;
  maxCteDepth?: number;
  /** 启用 EXPLAIN QUERY PLAN 成本门禁（默认 true） */
  enableExplainCost?: boolean;
  rejectUnfilteredScan?: boolean;
}

interface WorkerResult {
  rows: Record<string, unknown>[];
  columns: string[];
  durationMs: number;
  error?: string;
}

/** SQLite SqlExecutor：校验 → EXPLAIN 成本 → 超时 Worker 执行 → 审计脱敏 */
export class SqliteExecutor implements SqlExecutor {
  private readonly maxRows: number;
  private readonly allowedTables?: string[];
  private readonly allowedColumns?: Record<string, string[]>;
  private readonly requireFilterTables?: string[];
  private readonly maxJoins?: number;
  private readonly maxCteDepth?: number;
  private readonly enableExplainCost: boolean;
  private readonly rejectUnfilteredScan: boolean;

  constructor(private readonly options: SqliteExecutorOptions) {
    this.maxRows = options.maxRows ?? 10_000;
    this.allowedTables = options.allowedTables;
    this.allowedColumns = options.allowedColumns;
    this.requireFilterTables = options.requireFilterTables;
    this.maxJoins = options.maxJoins;
    this.maxCteDepth = options.maxCteDepth;
    this.enableExplainCost = options.enableExplainCost !== false;
    this.rejectUnfilteredScan = options.rejectUnfilteredScan !== false;
  }

  async explain(sql: string): Promise<string> {
    const plan = explainSqliteQueryPlan(this.options.db, sql);
    return plan.map((row) => String(row.detail ?? "")).join("\n");
  }

  async execute(
    request: SqlExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const validatorOpts = {
      dialectFamily: "sqlite" as const,
      maxRows: request.maxRows ?? this.maxRows,
      allowedTables: request.allowedTables ?? this.allowedTables,
      allowedColumns: request.allowedColumns ?? this.allowedColumns,
      deniedColumns: request.deniedColumns,
      requireFilterTables:
        request.requireFilterTables ?? this.requireFilterTables,
      maxJoins: request.maxJoins ?? this.maxJoins,
      maxCteDepth: request.maxCteDepth ?? this.maxCteDepth,
    };

    let sql: string;
    let params: (string | number)[] = request.params ?? [];

    if (request.rowFilters?.length) {
      const rewrite = applyRowFilters(
        request.sql,
        request.rowFilters,
        validatorOpts,
      );
      if (!rewrite.ok || !rewrite.sql) {
        const sanitized = sanitizeSqlError(
          rewrite.reason ?? "policy_rejected",
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
          rawError: rewrite.reason,
        });
        return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
      }
      sql = rewrite.sql;
      params = [...(rewrite.params ?? []), ...params];
    } else {
      const validation = validateSql(request.sql, validatorOpts);
      if (!validation.valid) {
        const kind = validation.failureKind ?? "policy_rejected";
        const sanitized = sanitizeSqlError(
          validation.reason ?? kind,
          kind,
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
      sql = validation.normalizedSql!;
    }

    if (this.enableExplainCost) {
      try {
        const planRows = explainSqliteQueryPlan(this.options.db, sql, params);
        const cost = assessExplainQueryPlan(planRows, {
          originalSql: sql,
          rejectUnfilteredScan: this.rejectUnfilteredScan,
        });
        if (!cost.allowed) {
          const sanitized = sanitizeSqlError(
            cost.reason ?? "cost_rejected",
            "cost_rejected",
          );
          auditLog({
            requestId: request.requestId ?? crypto.randomUUID(),
            subjectId: request.subjectId ?? "unknown",
            tenantId: request.tenantId,
            sessionId: request.sessionId,
            dataSourceId: request.dataSourceId,
            sql,
            durationMs: Date.now() - startTime,
            failureKind: sanitized.kind,
            rawError: cost.reason,
          });
          return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const kind = classifySqlError(raw);
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

    if (signal.aborted) {
      return emptyErrorResult("timeout", "查询已取消");
    }

    try {
      const workerResult =
        process.env.BI_SQLITE_SYNC === "1"
          ? executeSqliteSync(this.options.db, sql, params)
          : await runInWorker(
              this.options.db.name ?? ":memory:",
              sql,
              request.timeoutMs,
              signal,
              params,
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
    if (this.options.db.open) {
      this.options.db.close();
    }
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
  params: (string | number)[] = [],
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { dbPath, sql, params },
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
  params: (string | number)[] = [],
): WorkerResult {
  const start = Date.now();
  try {
    const stmt = db.prepare(sql);
    const rows = (
      params.length > 0 ? stmt.all(...params) : stmt.all()
    ) as Record<string, unknown>[];
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
