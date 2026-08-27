import type { ExecutionResult } from "../../entities.js";
import { auditLog } from "../../audit/logger.js";
import {
  classifySqlError,
  sanitizeSqlError,
  type SqlFailureKind,
} from "../../errors/sql-failure.js";
import { prepareExecutableSql } from "../prepare-sql.js";
import { assessSqlServerShowplan } from "../explain-cost.js";
import { CircuitBreaker, TenantConcurrencyLimiter } from "../pool.js";
import { runCancellableQuery } from "../query-cancellation.js";
import type {
  HealthStatus,
  SqlExecutionRequest,
  SqlExecutor,
} from "../types.js";

/**
 * SQL Server / T-SQL 查询客户端合约（可注入 mock / 可选 tedious）。
 *
 * 能力边界（experimental）：
 * - ✅ prepareExecutableSql（tsql AST + rowFilters + `@pN` 绑定）
 * - ✅ 超时取消 race、熔断、租户配额
 * - ✅ SET SHOWPLAN_TEXT 成本门禁（注入客户端可测）
 * - ❌ 无 Docker live；生产晋级需真实库 + 驱动连库认证
 */
export interface SqlServerQueryClient {
  query(
    sql: string,
    params?: (string | number)[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;
  ping(): Promise<void>;
  end(): Promise<void>;
}

export interface SqlServerExecutorOptions {
  dataSourceId: string;
  client: SqlServerQueryClient;
  maxRows?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  circuitBreaker?: CircuitBreaker;
  tenantLimiter?: TenantConcurrencyLimiter;
  enableExplainCost?: boolean;
  rejectUnfilteredScan?: boolean;
}

/** T-SQL SqlExecutor：校验 → rowFilters → SHOWPLAN 成本门禁 → 熔断/配额 → 执行 */
export class SqlServerExecutor implements SqlExecutor {
  private readonly maxRows: number;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly enableExplainCost: boolean;
  private readonly rejectUnfilteredScan: boolean;

  constructor(private readonly options: SqlServerExecutorOptions) {
    this.maxRows = options.maxRows ?? 10_000;
    this.breaker = options.circuitBreaker ?? new CircuitBreaker();
    this.limiter =
      options.tenantLimiter ?? new TenantConcurrencyLimiter(8);
    this.enableExplainCost = options.enableExplainCost !== false;
    this.rejectUnfilteredScan = options.rejectUnfilteredScan !== false;
  }

  async explain(sql: string): Promise<string> {
    const result = await this.options.client.query(
      `SET SHOWPLAN_TEXT ON; ${sql}; SET SHOWPLAN_TEXT OFF;`,
    );
    return result.rows.map((row) => Object.values(row).join(" ")).join("\n");
  }

  async execute(
    request: SqlExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const prepared = prepareExecutableSql({
      sql: request.sql,
      params: request.params,
      dialectFamily: "tsql",
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
        const plan = await runCancellableQuery({
          signal,
          timeoutMs: request.timeoutMs,
          query: (querySignal) =>
            this.options.client.query(
              `SET SHOWPLAN_TEXT ON; ${sql}; SET SHOWPLAN_TEXT OFF;`,
              params,
              { signal: querySignal, timeoutMs: request.timeoutMs },
            ),
        });
        const cost = assessSqlServerShowplan(plan.rows, {
          originalSql: sql,
          rejectUnfilteredScan: this.rejectUnfilteredScan,
        });
        if (!cost.allowed) {
          const sanitized = sanitizeSqlError(cost.reason ?? "cost_rejected", "cost_rejected");
          return emptyErrorResult(sanitized.kind, sanitized.safeMessage);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (signal.aborted || /timeout|cancel/i.test(raw)) {
          return emptyErrorResult("timeout", "Query cancelled");
        }
        const sanitized = sanitizeSqlError(`SQL Server SHOWPLAN failed: ${raw}`, "cost_rejected");
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

type TediousModule = {
  Connection: new (config: Record<string, unknown>) => {
    connect: (cb: (err?: Error) => void) => void;
    close: () => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    execSql: (request: unknown) => void;
  };
  Request: new (
    sql: string,
    cb: (err?: Error, rowCount?: number) => void,
  ) => {
    addParameter: (
      name: string,
      type: unknown,
      value: string | number,
    ) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    cancel?: () => void;
  };
  TYPES: { NVarChar: unknown; Int: unknown; Float: unknown };
};

async function loadTedious(): Promise<TediousModule> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<TediousModule>;
  try {
    return await dynamicImport("tedious");
  } catch {
    throw new Error(
      "SQL Server 可选驱动 tedious 未安装：请 pnpm add tedious，或向 SqlServerExecutor 注入 SqlServerQueryClient。" +
        "能力边界：编译/AST/Executor 合约已就绪；Docker live 与 production-certified 未完成。",
    );
  }
}

/**
 * 可选 tedious 连接。未安装驱动时抛出明确错误。
 * 每次 query 新建短连接（首步可落地；生产应换连接池）。
 */
export async function createSqlServerClient(options: {
  server: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}): Promise<SqlServerQueryClient> {
  const tedious = await loadTedious();
  const baseConfig = {
    server: options.server,
    authentication: {
      type: "default",
      options: {
        userName: options.user,
        password: options.password,
      },
    },
    options: {
      port: options.port ?? 1433,
      database: options.database,
      encrypt: options.encrypt !== false,
      trustServerCertificate: options.trustServerCertificate === true,
      rowCollectionOnRequestCompletion: true,
    },
  };

  function connectOnce(): Promise<InstanceType<TediousModule["Connection"]>> {
    return new Promise((resolve, reject) => {
      const connection = new tedious.Connection(baseConfig);
      connection.on("connect", (err: unknown) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(connection);
      });
      connection.connect((err) => {
        if (err) reject(err);
      });
    });
  }

  async function runQuery(
    sql: string,
    params: (string | number)[] = [],
    queryOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
    const connection = await connectOnce();
    try {
      return await new Promise<{
        rows: Record<string, unknown>[];
        columns: string[];
      }>((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        let columns: string[] = [];
        let settled = false;
        let cancel = () => {};
        const request = new tedious.Request(sql, (err) => {
          settled = true;
          queryOptions.signal?.removeEventListener("abort", cancel);
          if (err) reject(err);
          else resolve({ rows, columns });
        });
        cancel = () => {
          if (settled) return;
          settled = true;
          request.cancel?.();
          connection.close();
          reject(new Error("Query cancelled"));
        };
        if (queryOptions.signal?.aborted) {
          cancel();
          return;
        }
        queryOptions.signal?.addEventListener("abort", cancel, { once: true });
        params.forEach((value, i) => {
          const name = `p${i + 1}`;
          const type =
            typeof value === "number"
              ? Number.isInteger(value)
                ? tedious.TYPES.Int
                : tedious.TYPES.Float
              : tedious.TYPES.NVarChar;
          request.addParameter(name, type, value);
        });
        request.on("row", (columnsRaw: unknown) => {
          const cols = columnsRaw as Array<{
            metadata: { colName: string };
            value: unknown;
          }>;
          if (columns.length === 0) {
            columns = cols.map((c) => c.metadata.colName);
          }
          const row: Record<string, unknown> = {};
          for (const c of cols) {
            row[c.metadata.colName] = c.value;
          }
          rows.push(row);
        });
        connection.execSql(request);
      });
    } finally {
      connection.close();
    }
  }

  return {
    query: runQuery,
    async ping() {
      const { rows } = await runQuery("SELECT 1 AS ok");
      if (!rows.length) throw new Error("SQL Server ping 失败");
    },
    async end() {},
  };
}
