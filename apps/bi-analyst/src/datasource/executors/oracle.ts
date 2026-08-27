import type { ExecutionResult } from "../../entities.js";
import { auditLog } from "../../audit/logger.js";
import {
  classifySqlError,
  sanitizeSqlError,
  type SqlFailureKind,
} from "../../errors/sql-failure.js";
import { prepareExecutableSql } from "../prepare-sql.js";
import { assessOracleExplain } from "../explain-cost.js";
import { CircuitBreaker, TenantConcurrencyLimiter } from "../pool.js";
import { runCancellableQuery } from "../query-cancellation.js";
import type {
  HealthStatus,
  SqlExecutionRequest,
  SqlExecutor,
} from "../types.js";

/**
 * Oracle 查询客户端合约（可注入 mock / 可选 oracledb 池）。
 *
 * 能力边界（experimental）：
 * - ✅ prepareExecutableSql（oracle 方言 AST + rowFilters + `:n` 绑定）
 * - ✅ 超时取消 race、熔断、租户配额、只读语义由调用方/驱动保证
 * - ✅ EXPLAIN PLAN + DBMS_XPLAN.DISPLAY 成本门禁（注入客户端可测）
 * - ❌ 无 Docker live 矩阵；生产晋级仍需真实库 + 驱动连库认证
 */
export interface OracleQueryClient {
  query(
    sql: string,
    params?: (string | number)[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;
  ping(): Promise<void>;
  end(): Promise<void>;
}

export interface OracleExecutorOptions {
  dataSourceId: string;
  client: OracleQueryClient;
  maxRows?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  circuitBreaker?: CircuitBreaker;
  tenantLimiter?: TenantConcurrencyLimiter;
  enableExplainCost?: boolean;
  rejectUnfilteredScan?: boolean;
}

/** Oracle SqlExecutor：校验 → rowFilters → EXPLAIN 成本门禁 → 熔断/配额 → 执行 */
export class OracleExecutor implements SqlExecutor {
  private readonly maxRows: number;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly enableExplainCost: boolean;
  private readonly rejectUnfilteredScan: boolean;

  constructor(private readonly options: OracleExecutorOptions) {
    this.maxRows = options.maxRows ?? 10_000;
    this.breaker = options.circuitBreaker ?? new CircuitBreaker();
    this.limiter =
      options.tenantLimiter ?? new TenantConcurrencyLimiter(8);
    this.enableExplainCost = options.enableExplainCost !== false;
    this.rejectUnfilteredScan = options.rejectUnfilteredScan !== false;
  }

  async explain(sql: string): Promise<string> {
    const plan = await this.options.client.query(
      `EXPLAIN PLAN FOR ${sql}`,
    );
    const display = await this.options.client.query(
      "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())",
    );
    return [...plan.rows, ...display.rows]
      .map((row) => String(row.PLAN_TABLE_OUTPUT ?? Object.values(row).join(" ")))
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
      dialectFamily: "oracle",
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
    const params = prepared.params ?? [];
    if (signal.aborted) {
      return emptyErrorResult("timeout", "查询已取消");
    }

    if (this.enableExplainCost) {
      try {
        const [plan, display] = await runCancellableQuery({
          signal,
          timeoutMs: request.timeoutMs,
          query: async (querySignal) => [
            await this.options.client.query(`EXPLAIN PLAN FOR ${sql}`, params, {
              signal: querySignal,
              timeoutMs: request.timeoutMs,
            }),
            await this.options.client.query(
              "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())",
              [],
              { signal: querySignal, timeoutMs: request.timeoutMs },
            ),
          ],
        });
        const cost = assessOracleExplain(
          [...plan.rows, ...display.rows],
          { originalSql: sql, rejectUnfilteredScan: this.rejectUnfilteredScan },
        );
        if (!cost.allowed) {
          const sanitized = sanitizeSqlError(cost.reason ?? "cost_rejected", "cost_rejected");
          return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (signal.aborted || /timeout|cancel/i.test(raw)) {
          return emptyErrorResult("timeout", "Query cancelled");
        }
        const sanitized = sanitizeSqlError(`Oracle EXPLAIN PLAN failed: ${raw}`, "cost_rejected");
        return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
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

type OracleDbModule = {
  createPool: (cfg: Record<string, unknown>) => Promise<{
    getConnection: () => Promise<{
      execute: (
        sql: string,
        binds: unknown,
        opts?: Record<string, unknown>,
      ) => Promise<{
        rows?: Record<string, unknown>[];
        metaData?: Array<{ name: string }>;
      }>;
      close: () => Promise<void>;
      ping: () => Promise<void>;
      break?: () => Promise<void>;
      callTimeout?: number;
    }>;
    close: (drain?: number) => Promise<void>;
  }>;
  OUT_FORMAT_OBJECT: number;
};

async function loadOracleDb(): Promise<OracleDbModule> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<OracleDbModule>;
  try {
    return await dynamicImport("oracledb");
  } catch {
    throw new Error(
      "Oracle 可选驱动 oracledb 未安装：请 pnpm add oracledb，或向 OracleExecutor 注入 OracleQueryClient。" +
        "能力边界：编译/AST/Executor 合约已就绪；Docker live 与 production-certified 未完成。",
    );
  }
}

/**
 * 可选 oracledb 连接池。未安装驱动时抛出明确错误（不静默回退 stub）。
 * connectString 示例：`localhost:1521/XEPDB1`
 */
export async function createOraclePoolClient(options: {
  user: string;
  password: string;
  connectString: string;
  poolMax?: number;
}): Promise<OracleQueryClient> {
  const oracledb = await loadOracleDb();
  const pool = await oracledb.createPool({
    user: options.user,
    password: options.password,
    connectString: options.connectString,
    poolMax: options.poolMax ?? 4,
    poolMin: 0,
  });

  return {
    async query(sql, params = [], queryOptions = {}) {
      const conn = await pool.getConnection();
      if (queryOptions.timeoutMs && "callTimeout" in conn) {
        conn.callTimeout = queryOptions.timeoutMs;
      }
      const cancel = () => {
        void conn.break?.().catch(() => undefined);
      };
      if (queryOptions.signal?.aborted) cancel();
      else queryOptions.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await conn.execute(sql, params, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const rows = (result.rows ?? []) as Record<string, unknown>[];
        const columns =
          result.metaData?.map((m) => m.name) ??
          (rows[0] ? Object.keys(rows[0]) : []);
        return { rows, columns };
      } finally {
        queryOptions.signal?.removeEventListener("abort", cancel);
        await conn.close();
      }
    },
    async ping() {
      const conn = await pool.getConnection();
      try {
        await conn.ping();
      } finally {
        await conn.close();
      }
    },
    async end() {
      await pool.close(0);
    },
  };
}
