import type Database from "better-sqlite3";
import type { DialectFamily } from "./types.js";

export interface ExplainCostOptions {
  /** 计划明细行数上限（默认 40） */
  maxPlanRows?: number;
  /** 无 WHERE 时是否拒绝 SCAN（全表扫描）；聚合查询可豁免 */
  rejectUnfilteredScan?: boolean;
  /** 原始 SQL，用于判断是否有 WHERE */
  originalSql?: string;
  /** Optional upper bound for an estimated plan cost parsed from text. */
  maxEstimatedCost?: number;
}

export interface ExplainCostResult {
  allowed: boolean;
  reason?: string;
  planText: string;
}

function sqlShape(originalSql: string | undefined): {
  hasWhere: boolean;
  isAggregate: boolean;
} {
  return {
    hasWhere: /\bWHERE\b/i.test(originalSql ?? ""),
    isAggregate: /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(originalSql ?? ""),
  };
}

/** 解析 SQLite EXPLAIN QUERY PLAN 输出，做启发式成本拦截 */
export function assessExplainQueryPlan(
  planRows: Array<Record<string, unknown>>,
  options: ExplainCostOptions = {},
): ExplainCostResult {
  const maxPlanRows = options.maxPlanRows ?? 40;
  const planText = planRows
    .map((row) => String(row.detail ?? Object.values(row).join(" ")))
    .join("\n");

  if (planRows.length > maxPlanRows) {
    return {
      allowed: false,
      reason: `查询计划过于复杂（${planRows.length} 步，上限 ${maxPlanRows}）`,
      planText,
    };
  }

  const { hasWhere, isAggregate } = sqlShape(options.originalSql);
  const scans = planRows.filter((row) =>
    /\bSCAN\b/i.test(String(row.detail ?? "")),
  );

  if (
    options.rejectUnfilteredScan !== false &&
    !hasWhere &&
    !isAggregate &&
    scans.length > 0
  ) {
    const detail = String(scans[0]?.detail ?? "SCAN");
    return {
      allowed: false,
      reason: `无过滤全表扫描被拒绝: ${detail}`,
      planText,
    };
  }

  return { allowed: true, planText };
}

/**
 * MySQL EXPLAIN：`type=ALL` 且无 WHERE 的明细查询视为全表扫描。
 */
export function assessMysqlExplain(
  planRows: Array<Record<string, unknown>>,
  options: ExplainCostOptions = {},
): ExplainCostResult {
  const maxPlanRows = options.maxPlanRows ?? 40;
  const planText = planRows
    .map((row) =>
      [
        row.table,
        row.type,
        row.key,
        row.rows,
        row.Extra ?? row.extra,
      ]
        .filter((v) => v != null && String(v) !== "")
        .join(" "),
    )
    .join("\n");

  if (planRows.length > maxPlanRows) {
    return {
      allowed: false,
      reason: `查询计划过于复杂（${planRows.length} 步，上限 ${maxPlanRows}）`,
      planText,
    };
  }

  const { hasWhere, isAggregate } = sqlShape(options.originalSql);
  const fullScans = planRows.filter((row) => {
    const type = String(row.type ?? "").toUpperCase();
    return type === "ALL";
  });

  if (
    options.rejectUnfilteredScan !== false &&
    !hasWhere &&
    !isAggregate &&
    fullScans.length > 0
  ) {
    const table = String(fullScans[0]?.table ?? "?");
    return {
      allowed: false,
      reason: `无过滤全表扫描被拒绝: type=ALL table=${table}`,
      planText,
    };
  }

  return { allowed: true, planText };
}

/**
 * PostgreSQL EXPLAIN（JSON 或文本行）：无 WHERE 明细遇 Seq Scan 拒绝。
 */
export function assessPostgresExplain(
  planRows: Array<Record<string, unknown>>,
  options: ExplainCostOptions = {},
): ExplainCostResult {
  const maxPlanRows = options.maxPlanRows ?? 40;
  const planText = planRows
    .map((row) => {
      if (typeof row["QUERY PLAN"] === "string") {
        return String(row["QUERY PLAN"]);
      }
      if (row.Plan && typeof row.Plan === "object") {
        return JSON.stringify(row.Plan);
      }
      return Object.values(row)
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join(" ");
    })
    .join("\n");

  if (planRows.length > maxPlanRows) {
    return {
      allowed: false,
      reason: `查询计划过于复杂（${planRows.length} 步，上限 ${maxPlanRows}）`,
      planText,
    };
  }

  const { hasWhere, isAggregate } = sqlShape(options.originalSql);
  const hasSeqScan = /Seq Scan/i.test(planText);

  if (
    options.rejectUnfilteredScan !== false &&
    !hasWhere &&
    !isAggregate &&
    hasSeqScan
  ) {
    return {
      allowed: false,
      reason: "无过滤全表扫描被拒绝: Seq Scan",
      planText,
    };
  }

  return { allowed: true, planText };
}

function assessPlanText(
  planText: string,
  planRowCount: number,
  options: ExplainCostOptions,
  fullScanPattern: RegExp,
  dialectName: string,
): ExplainCostResult {
  const maxPlanRows = options.maxPlanRows ?? 40;
  if (planRowCount > maxPlanRows) {
    return {
      allowed: false,
      reason: `查询计划过于复杂（${planRowCount} 步，上限 ${maxPlanRows}）`,
      planText,
    };
  }

  const estimatedCosts = [...planText.matchAll(
    /(?:cost\s*[=:]\s*(?:\d+(?:\.\d+)?\.\.)?([\d.]+)|EstimatedTotalSubtreeCost\s*[=:" ]+([\d.]+))/gi,
  )]
    .map((m) => Number(m[1] ?? m[2]))
    .filter((n) => Number.isFinite(n));
  const maxEstimatedCost = options.maxEstimatedCost;
  if (
    maxEstimatedCost !== undefined &&
    estimatedCosts.some((cost) => cost > maxEstimatedCost)
  ) {
    return {
      allowed: false,
      reason: `${dialectName} 查询计划估算成本超过上限 ${maxEstimatedCost}`,
      planText,
    };
  }

  const { hasWhere, isAggregate } = sqlShape(options.originalSql);
  if (
    options.rejectUnfilteredScan !== false &&
    !hasWhere &&
    !isAggregate &&
    fullScanPattern.test(planText)
  ) {
    return {
      allowed: false,
      reason: `无过滤全表扫描被拒绝: ${dialectName}`,
      planText,
    };
  }

  return { allowed: true, planText };
}

/** Oracle DBMS_XPLAN.DISPLAY 文本成本门禁。 */
export function assessOracleExplain(
  planRows: Array<Record<string, unknown>>,
  options: ExplainCostOptions = {},
): ExplainCostResult {
  const planText = planRows
    .map((row) =>
      String(
        row.PLAN_TABLE_OUTPUT ??
          row["plan_table_output"] ??
          Object.values(row).join(" "),
      ),
    )
    .join("\n");
  return assessPlanText(
    planText,
    planRows.length,
    options,
    /TABLE ACCESS FULL|FULL TABLE SCAN/i,
    "Oracle",
  );
}

/** SQL Server SHOWPLAN_TEXT/XML 文本成本门禁。 */
export function assessSqlServerShowplan(
  planRows: Array<Record<string, unknown>>,
  options: ExplainCostOptions = {},
): ExplainCostResult {
  const planText = planRows
    .map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" "),
    )
    .join("\n");
  return assessPlanText(
    planText,
    planRows.length,
    options,
    /\b(?:Table Scan|Clustered Index Scan|Index Scan)\b/i,
    "SQL Server",
  );
}

/** 按方言分发成本评估 */
export function assessExplainByDialect(
  dialect: DialectFamily,
  planRows: Array<Record<string, unknown>>,
  options: ExplainCostOptions = {},
): ExplainCostResult {
  switch (dialect) {
    case "mysql":
      return assessMysqlExplain(planRows, options);
    case "postgresql":
      return assessPostgresExplain(planRows, options);
    case "oracle":
      return assessOracleExplain(planRows, options);
    case "tsql":
      return assessSqlServerShowplan(planRows, options);
    case "sqlite":
    default:
      return assessExplainQueryPlan(planRows, options);
  }
}

/** 对 SQLite 执行 EXPLAIN QUERY PLAN（支持绑定参数） */
export function explainSqliteQueryPlan(
  db: Database.Database,
  sql: string,
  params: (string | number)[] = [],
): Array<Record<string, unknown>> {
  const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  return (
    params.length > 0 ? stmt.all(...params) : stmt.all()
  ) as Array<Record<string, unknown>>;
}
