import type { DialectFamily } from "../datasource/types.js";
import { quoteIdentifier, renderPagination } from "../datasource/dialect.js";
import { renderTimeBucket } from "../datasource/time-bucket.js";
import type { LogicalQuery, FilterExpression } from "./logical-query.js";

export interface CompileResult {
  ok: boolean;
  sql?: string;
  params?: (string | number)[];
  reason?: string;
  dialectFamily?: DialectFamily;
}

interface ResolvedRef {
  table: string;
  column: string;
  alias?: string;
}

export interface CompileLogicalQueryOptions {
  /** table.column → 物理列；缺省时直接使用 ref */
  resolveRef?: (ref: string) => ResolvedRef | null;
  defaultTable?: string;
  dialectFamily?: DialectFamily;
}

/**
 * LogicalQuery → 方言 SQL（确定性编译，无 LLM）。
 * 占位符统一为 `?`；PostgreSQL 由 prepareExecutableSql 转为 `$n`。
 */
export function compileLogicalQuery(
  query: LogicalQuery,
  options: CompileLogicalQueryOptions = {},
): CompileResult {
  const dialect = options.dialectFamily ?? "sqlite";
  const q = (name: string) => quoteIdentifier(dialect, name);

  const resolve =
    options.resolveRef ??
    ((ref: string): ResolvedRef | null => {
      if (ref.includes(".")) {
        const [table, column] = ref.split(".", 2);
        return { table: table!, column: column! };
      }
      if (options.defaultTable) {
        return { table: options.defaultTable, column: ref };
      }
      return null;
    });

  const selectParts: string[] = [];
  const groupParts: string[] = [];
  const tables = new Set<string>();
  const params: (string | number)[] = [];

  let timeBucketExpr: string | undefined;
  if (query.timeGrain) {
    const r = resolve(query.timeGrain.field);
    if (!r) {
      return {
        ok: false,
        reason: `无法解析时间粒度字段: ${query.timeGrain.field}`,
      };
    }
    tables.add(r.table);
    timeBucketExpr = renderTimeBucket(
      dialect,
      `${q(r.table)}.${q(r.column)}`,
      query.timeGrain.grain,
    );
    selectParts.push(
      `${timeBucketExpr} AS ${q(`time_${query.timeGrain.grain}`)}`,
    );
    groupParts.push(timeBucketExpr);
  }

  for (const dim of query.dimensions) {
    const r = resolve(dim.ref);
    if (!r) return { ok: false, reason: `无法解析维度: ${dim.ref}` };
    tables.add(r.table);
    const expr = q(r.table) + "." + q(r.column);
    selectParts.push(`${expr} AS ${q(r.column)}`);
    groupParts.push(expr);
  }

  for (const measure of query.measures) {
    const r = resolve(measure.ref);
    if (!r && measure.aggregation !== "count") {
      return { ok: false, reason: `无法解析度量: ${measure.ref}` };
    }
    if (r) tables.add(r.table);
    const agg = measure.aggregation ?? "sum";
    const alias = measure.ref.includes(".")
      ? measure.ref.split(".").pop()!
      : measure.ref;
    if (agg === "count" && (measure.ref === "*" || measure.ref === "1")) {
      selectParts.push(`COUNT(*) AS ${q(alias)}`);
    } else if (agg === "count_distinct" && r) {
      selectParts.push(
        `COUNT(DISTINCT ${q(r.table)}.${q(r.column)}) AS ${q(alias)}`,
      );
    } else if (r) {
      const fn = agg.toUpperCase();
      selectParts.push(
        `${fn}(${q(r.table)}.${q(r.column)}) AS ${q(alias)}`,
      );
    } else {
      return { ok: false, reason: `无法编译度量: ${measure.ref}` };
    }
  }

  if (selectParts.length === 0) {
    return { ok: false, reason: "LogicalQuery 缺少 measures/dimensions" };
  }

  if (tables.size === 0 && options.defaultTable) {
    tables.add(options.defaultTable);
  }
  if (tables.size === 0) {
    return { ok: false, reason: "无法确定查询表" };
  }

  const fromTable = [...tables][0]!;
  let sql = `SELECT ${selectParts.join(", ")} FROM ${q(fromTable)}`;

  if (tables.size > 1) {
    return {
      ok: false,
      reason: "多表 LogicalQuery 请经由语义层编译（含 join path）",
    };
  }

  const whereParts: string[] = [];
  for (const filter of query.filters) {
    const compiled = compileFilter(filter, resolve, params, q);
    if (!compiled.ok) return { ok: false, reason: compiled.reason };
    whereParts.push(compiled.clause!);
  }

  if (query.timeRange) {
    const r = resolve(query.timeRange.field);
    if (!r) {
      return { ok: false, reason: `无法解析时间字段: ${query.timeRange.field}` };
    }
    whereParts.push(`${q(r.table)}.${q(r.column)} >= ?`);
    params.push(query.timeRange.from);
    whereParts.push(`${q(r.table)}.${q(r.column)} <= ?`);
    params.push(query.timeRange.to);
  }

  if (whereParts.length > 0) {
    sql += ` WHERE ${whereParts.join(" AND ")}`;
  }

  if (groupParts.length > 0 && query.measures.length > 0) {
    sql += ` GROUP BY ${groupParts.join(", ")}`;
  }

  if (query.orderBy?.length) {
    const orderParts: string[] = [];
    for (const o of query.orderBy) {
      const r = resolve(o.ref);
      if (r) {
        orderParts.push(
          `${q(r.table)}.${q(r.column)} ${o.direction.toUpperCase()}`,
        );
      } else {
        orderParts.push(`${q(o.ref)} ${o.direction.toUpperCase()}`);
      }
    }
    sql += ` ORDER BY ${orderParts.join(", ")}`;
  } else if (timeBucketExpr) {
    sql += ` ORDER BY ${timeBucketExpr} ASC`;
  }

  if (query.limit) {
    sql += ` ${renderPagination(dialect, query.limit, 0)}`;
  }

  return { ok: true, sql, params, dialectFamily: dialect };
}

/** @deprecated 使用 compileLogicalQuery(..., { dialectFamily: "sqlite" }) */
export function compileLogicalQueryToSqlite(
  query: LogicalQuery,
  options?: Omit<CompileLogicalQueryOptions, "dialectFamily">,
): CompileResult {
  return compileLogicalQuery(query, { ...options, dialectFamily: "sqlite" });
}

export function compileLogicalQueryToMysql(
  query: LogicalQuery,
  options?: Omit<CompileLogicalQueryOptions, "dialectFamily">,
): CompileResult {
  return compileLogicalQuery(query, { ...options, dialectFamily: "mysql" });
}

export function compileLogicalQueryToPostgresql(
  query: LogicalQuery,
  options?: Omit<CompileLogicalQueryOptions, "dialectFamily">,
): CompileResult {
  return compileLogicalQuery(query, {
    ...options,
    dialectFamily: "postgresql",
  });
}

export function compileLogicalQueryToOracle(
  query: LogicalQuery,
  options?: Omit<CompileLogicalQueryOptions, "dialectFamily">,
): CompileResult {
  return compileLogicalQuery(query, { ...options, dialectFamily: "oracle" });
}

export function compileLogicalQueryToTsql(
  query: LogicalQuery,
  options?: Omit<CompileLogicalQueryOptions, "dialectFamily">,
): CompileResult {
  return compileLogicalQuery(query, { ...options, dialectFamily: "tsql" });
}

function compileFilter(
  filter: FilterExpression,
  resolve: (ref: string) => ResolvedRef | null,
  params: (string | number)[],
  q: (name: string) => string,
): { ok: boolean; clause?: string; reason?: string } {
  const r = resolve(filter.field);
  if (!r) return { ok: false, reason: `无法解析过滤字段: ${filter.field}` };
  const left = `${q(r.table)}.${q(r.column)}`;

  switch (filter.operator) {
    case "in":
    case "not_in": {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (values.length === 0) {
        return { ok: false, reason: "in/not_in 不能为空" };
      }
      const ph = values.map(() => "?").join(", ");
      for (const v of values) {
        if (typeof v === "boolean") params.push(v ? 1 : 0);
        else params.push(v);
      }
      const op = filter.operator === "in" ? "IN" : "NOT IN";
      return { ok: true, clause: `${left} ${op} (${ph})` };
    }
    case "like": {
      params.push(String(filter.value));
      return { ok: true, clause: `${left} LIKE ?` };
    }
    default: {
      const v = filter.value;
      if (Array.isArray(v)) {
        return { ok: false, reason: `${filter.operator} 不接受数组值` };
      }
      params.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      return { ok: true, clause: `${left} ${filter.operator} ?` };
    }
  }
}
