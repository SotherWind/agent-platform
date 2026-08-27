import type { ExecutionResult } from "../../entities.js";
import { auditLog } from "../../audit/logger.js";
import {
  classifySqlError,
  sanitizeSqlError,
  type SqlFailureKind,
} from "../../errors/sql-failure.js";
import { prepareExecutableSql } from "../prepare-sql.js";
import { assessPostgresExplain } from "../explain-cost.js";
import { CircuitBreaker, TenantConcurrencyLimiter } from "../pool.js";
import { resolveTlsOptions, toPostgresSslConfig } from "../tls.js";
import { runCancellableQuery } from "../query-cancellation.js";
import type {
  HealthStatus,
  SqlExecutionRequest,
  SqlExecutor,
} from "../types.js";

export interface PostgresQueryClient {
  query(
    sql: string,
    params?: (string | number)[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;
  ping(): Promise<void>;
  end(): Promise<void>;
}

export interface PostgresExecutorOptions {
  dataSourceId: string;
  client: PostgresQueryClient;
  maxRows?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  circuitBreaker?: CircuitBreaker;
  tenantLimiter?: TenantConcurrencyLimiter;
  /** 启用 EXPLAIN 成本门禁（默认 true） */
  enableExplainCost?: boolean;
  rejectUnfilteredScan?: boolean;
  failOpenOnExplainError?: boolean;
}

/** PostgreSQL SqlExecutor：校验 → EXPLAIN 成本 → rowFilters → 熔断/租户配额 → 执行 → 审计 */
export class PostgresExecutor implements SqlExecutor {
  private readonly maxRows: number;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly enableExplainCost: boolean;
  private readonly rejectUnfilteredScan: boolean;
  private readonly failOpenOnExplainError: boolean;

  constructor(private readonly options: PostgresExecutorOptions) {
    this.maxRows = options.maxRows ?? 10_000;
    this.breaker = options.circuitBreaker ?? new CircuitBreaker();
    this.limiter =
      options.tenantLimiter ?? new TenantConcurrencyLimiter(8);
    this.enableExplainCost = options.enableExplainCost !== false;
    this.rejectUnfilteredScan = options.rejectUnfilteredScan !== false;
    this.failOpenOnExplainError = options.failOpenOnExplainError === true;
  }

  async explain(sql: string): Promise<string> {
    const result = await this.options.client.query(`EXPLAIN ${sql}`);
    return result.rows
      .map((row) => String(row["QUERY PLAN"] ?? Object.values(row).join(" ")))
      .join("\n");
  }

  async execute(
    request: SqlExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const prepared = prepareExecutableSql({
      sql: request.sql,
      params: request.params,
      dialectFamily: "postgresql",
      maxRows: request.maxRows ?? this.maxRows,
      allowedTables: request.allowedTables ?? this.options.allowedTables,
      allowedColumns: request.allowedColumns ?? this.options.allowedColumns,
      deniedColumns: request.deniedColumns,
      rowFilters: request.rowFilters,
    });

    if (!prepared.ok || !prepared.sql) {
      const kind = prepared.failureKind ?? "policy_rejected";
      const sanitized = sanitizeSqlError(prepared.reason ?? kind, kind);
      auditLog({
        requestId: request.requestId ?? crypto.randomUUID(),
        subjectId: request.subjectId ?? "unknown",
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        dataSourceId: request.dataSourceId,
        sql: request.sql,
        durationMs: Date.now() - startTime,
        failureKind: sanitized.kind,
        rawError: prepared.reason,
      });
      return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
    }

    const sql = prepared.sql;
    const params = prepared.params;
    if (signal.aborted) {
      return emptyErrorResult("timeout", "查询已取消");
    }

    if (this.enableExplainCost) {
      try {
        const plan = await runCancellableQuery({
          signal,
          timeoutMs: request.timeoutMs,
          query: (querySignal) =>
            this.options.client.query(`EXPLAIN ${sql}`, params, {
              signal: querySignal,
              timeoutMs: request.timeoutMs,
            }),
        });
        const cost = assessPostgresExplain(plan.rows, {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (signal.aborted || /timeout|cancel/i.test(message)) {
          return emptyErrorResult("timeout", "查询已取消");
        }
        if (!this.failOpenOnExplainError) {
          return emptyErrorResult("cost_rejected", "EXPLAIN cost check failed");
        }
      }
    }

    try {
      const result = await this.limiter.run(request.tenantId, () =>
        this.breaker.exec(() =>
          runCancellableQuery({
            signal,
            timeoutMs: request.timeoutMs,
            query: (querySignal) =>
              this.options.client.query(sql, params, {
                signal: querySignal,
                timeoutMs: request.timeoutMs,
              }),
          }),
        ),
      );

      auditLog({
        requestId: request.requestId ?? crypto.randomUUID(),
        subjectId: request.subjectId ?? "unknown",
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        dataSourceId: request.dataSourceId,
        sql,
        durationMs: Date.now() - startTime,
        rowCount: result.rows.length,
      });

      if (result.rows.length === 0) {
        return {
          rows: [],
          columns: [],
          isEmpty: true,
          stats: { durationMs: Date.now() - startTime, rowCount: 0 },
        };
      }

      return {
        rows: result.rows,
        columns: result.columns,
        isEmpty: false,
        stats: {
          durationMs: Date.now() - startTime,
          rowCount: result.rows.length,
        },
      };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const kind: SqlFailureKind = /timeout|cancel/i.test(raw)
        ? "timeout"
        : /熔断|并发/.test(raw)
          ? "connection_error"
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
      await this.options.client.ping();
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
    await this.options.client.end();
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

export async function createPostgresPoolClient(options: {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  readOnly?: boolean;
  max?: number;
  requireVerifiedTls?: boolean;
}): Promise<PostgresQueryClient> {
  const { Pool } = await import("pg");
  const tls = resolveTlsOptions({
    ssl: options.ssl,
    rejectUnauthorized: options.rejectUnauthorized,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    requireVerified: options.requireVerifiedTls,
  });
  const pool = new Pool({
    host: options.host,
    port: options.port ?? 5432,
    user: options.user,
    password: options.password,
    database: options.database,
    ssl: toPostgresSslConfig(tls),
    max: options.max ?? 10,
  });
  const readOnly = options.readOnly !== false;

  return {
    async query(sql, params = [], queryOptions = {}) {
      const client = await pool.connect();
      let released = false;
      const cancel = () => {
        if (!released) {
          released = true;
          client.release(true);
        }
      };
      queryOptions.signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (readOnly) {
          await client.query("BEGIN READ ONLY");
        }
        try {
          const result = (await client.query({
            text: sql,
            values: params,
            query_timeout: queryOptions.timeoutMs,
          } as never)) as {
            rows: Record<string, unknown>[];
            fields?: Array<{ name: string }>;
          };
          if (readOnly) await client.query("COMMIT");
          const rows = result.rows as Record<string, unknown>[];
          const columns =
            result.fields?.map((f) => f.name) ??
            (rows[0] ? Object.keys(rows[0]) : []);
          return { rows, columns };
        } catch (err) {
          if (readOnly) {
            try {
              await client.query("ROLLBACK");
            } catch {
              /* ignore */
            }
          }
          throw err;
        }
      } finally {
        queryOptions.signal?.removeEventListener("abort", cancel);
        if (!released) client.release();
      }
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async end() {
      await pool.end();
    },
  };
}
