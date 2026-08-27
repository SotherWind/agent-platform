import type { DialectFamily } from "../datasource/types.js";
import { quoteIdentifier, renderPagination } from "../datasource/dialect.js";
import { renderTimeBucket } from "../datasource/time-bucket.js";
import type { MetricDefinition, MetricRegistry } from "./metric-registry.js";
import type {
  LogicalQuery,
  FilterExpression,
  TimeGrain,
} from "../query-plan/logical-query.js";
import { compileLogicalQuery } from "../query-plan/dialect-compiler.js";
import type { ClarificationRequest } from "../query-plan/clarification.js";
import { timeRangeClarificationOptions } from "./calendar.js";

export interface MetricCompileRequest {
  metric: MetricDefinition;
  /** Required when compiling a governed formula metric. */
  registry?: MetricRegistry;
  dimensions?: string[];
  filters?: FilterExpression[];
  timeRange?: LogicalQuery["timeRange"];
  timeGrain?: TimeGrain;
  limit?: number;
  /** 目标方言；缺省 sqlite（本地 demo） */
  dialectFamily?: DialectFamily;
}

export interface MetricCompileResult {
  ok: boolean;
  logicalQuery?: LogicalQuery;
  sql?: string;
  params?: (string | number)[];
  reason?: string;
  clarification?: ClarificationRequest;
  dialectFamily?: DialectFamily;
}

/**
 * certified 指标 → LogicalQuery → 方言 SQL。
 * 多对多 fanout 直接拒绝；编译失败不降级。
 */
export function compileCertifiedMetric(
  request: MetricCompileRequest,
): MetricCompileResult {
  const { metric } = request;
  const dialect = request.dialectFamily ?? "sqlite";

  if (metric.status !== "certified") {
    return { ok: false, reason: `指标 ${metric.metric} 未 certification` };
  }

  if (metric.formula) {
    if (!request.registry) {
      return { ok: false, reason: `派生指标 ${metric.metric} 需要 MetricRegistry 才能编译` };
    }
    return compileDerivedMetric(request, dialect);
  }

  const selectedDims = request.dimensions ?? [];
  const fanout = detectFanout(metric, selectedDims);
  if (fanout) {
    return { ok: false, reason: fanout };
  }

  if (metric.requireTimeRange && !request.timeRange) {
    return {
      ok: false,
      clarification: {
        reason: "missing_time_range",
        question: `指标「${metric.label}」需要指定时间范围`,
        options: timeRangeClarificationOptions(),
      },
    };
  }

  const dimensionDefs = selectedDims.map((name) => {
    const dim = metric.dimensions.find((d) => d.name === name);
    if (!dim) {
      return null;
    }
    return dim;
  });

  if (dimensionDefs.some((d) => d === null)) {
    return { ok: false, reason: "包含指标未定义的维度" };
  }

  const filters: FilterExpression[] = [
    ...metric.defaultFilters.map((f) => ({
      field: `${metric.factTable}.${f.field}`,
      operator: f.operator as FilterExpression["operator"],
      value: f.value,
    })),
    ...(request.filters ?? []),
  ];

  const needsJoin =
    dimensionDefs.some((d) => d?.joinPath) ||
    filters.some((filter) => {
      const table = filter.field.split(".", 2)[0];
      return Boolean(table && table !== metric.factTable);
    });
  if (needsJoin) {
    return compileWithJoins(metric, selectedDims, filters, request, dialect);
  }

  const logicalQuery: LogicalQuery = {
    source: metric.datasourceId,
    metricId: metric.metric,
    measures: [
      {
        ref: `${metric.factTable}.${metric.measure.field}`,
        aggregation: metric.measure.aggregation,
      },
    ],
    dimensions: dimensionDefs.map((d) => ({
      ref: `${d!.table}.${d!.column}`,
    })),
    filters,
    timeRange: request.timeRange
      ? {
          ...request.timeRange,
          field: `${metric.factTable}.${metric.timeDimension}`,
          timezone: request.timeRange.timezone || metric.timezone,
        }
      : undefined,
    timeGrain: request.timeGrain
      ? {
          field: `${metric.factTable}.${metric.timeDimension}`,
          grain: request.timeGrain,
        }
      : undefined,
    limit: request.limit,
  };

  const compiled = compileLogicalQuery(logicalQuery, {
    dialectFamily: dialect,
    defaultTable: metric.factTable,
    resolveRef: (ref) => {
      if (ref.includes(".")) {
        const [table, column] = ref.split(".", 2);
        return { table: table!, column: column! };
      }
      return { table: metric.factTable, column: ref };
    },
  });

  if (!compiled.ok) {
    return { ok: false, reason: compiled.reason };
  }

  return {
    ok: true,
    logicalQuery,
    sql: compiled.sql,
    params: compiled.params,
    dialectFamily: dialect,
  };
}

function compileDerivedMetric(
  request: MetricCompileRequest,
  dialect: DialectFamily,
): MetricCompileResult {
  const metric = request.metric;
  const registry = request.registry!;
  if (metric.dependsOn.length === 0) {
    return { ok: false, reason: `派生指标 ${metric.metric} 缺少 dependsOn` };
  }
  const dependencies = metric.dependsOn.map((id) => registry.get(id));
  if (dependencies.some((dependency) => !dependency || dependency.status !== "certified")) {
    return { ok: false, reason: `派生指标 ${metric.metric} 引用了未认证依赖` };
  }
  const resolved = dependencies as MetricDefinition[];
  const base = resolved[0]!;
  if (
    resolved.some(
      (dependency) =>
        dependency.datasourceId !== base.datasourceId ||
        dependency.factTable !== base.factTable ||
        dependency.timeDimension !== base.timeDimension,
    )
  ) {
    return { ok: false, reason: `派生指标 ${metric.metric} 的依赖必须来自同一事实表和时间字段` };
  }
  if (resolved.some((dependency) => dependency.defaultFilters.length > 0)) {
    return {
      ok: false,
      reason: `派生指标 ${metric.metric} 暂不允许包含独立默认过滤器的依赖，请显式定义条件聚合`,
    };
  }
  if (metric.requireTimeRange && !request.timeRange) {
    return {
      ok: false,
      clarification: {
        reason: "missing_time_range",
        question: `指标“${metric.label}”需要指定时间范围`,
        options: timeRangeClarificationOptions(),
      },
    };
  }

  const selectedDims = request.dimensions ?? [];
  const dimensionDefs = selectedDims.map((name) => metric.dimensions.find((dimension) => dimension.name === name));
  if (dimensionDefs.some((dimension) => !dimension)) {
    return { ok: false, reason: `派生指标 ${metric.metric} 未声明请求维度` };
  }
  const fanout = detectFanout(metric, selectedDims);
  if (fanout) return { ok: false, reason: fanout };

  const q = (name: string) => quoteIdentifier(dialect, name);
  const select: string[] = [];
  const groupBy: string[] = [];
  const joins: string[] = [];
  const joined = new Set<string>();
  const params: (string | number)[] = [];
  const timeBucket = request.timeGrain
    ? renderTimeBucket(
        dialect,
        `${q(metric.factTable)}.${q(metric.timeDimension)}`,
        request.timeGrain,
      )
    : undefined;
  if (timeBucket && request.timeGrain) {
    select.push(`${timeBucket} AS ${q(`time_${request.timeGrain}`)}`);
    groupBy.push(timeBucket);
  }
  for (const dimension of dimensionDefs) {
    if (!dimension) continue;
    const expression = `${q(dimension.table)}.${q(dimension.column)}`;
    select.push(`${expression} AS ${q(dimension.name)}`);
    groupBy.push(expression);
    if (dimension.joinPath && !joined.has(dimension.joinPath)) {
      const edge = metric.joinGraph.find((candidate) => candidate.name === dimension.joinPath);
      if (!edge) return { ok: false, reason: `维度 ${dimension.name} 缺少 joinPath 定义` };
      joins.push(
        `JOIN ${q(edge.to)} ON ${q(edge.from)}.${q(edge.fromKey)} = ${q(edge.to)}.${q(edge.toKey)}`,
      );
      joined.add(edge.name);
    }
  }

  const filters: FilterExpression[] = [
    ...metric.defaultFilters.map((filter) => ({
      field: `${metric.factTable}.${filter.field}`,
      operator: filter.operator as FilterExpression["operator"],
      value: filter.value,
    })),
    ...(request.filters ?? []),
  ];
  for (const filter of filters) {
    const table = filter.field.split(".", 2)[0];
    if (!table || table === metric.factTable) continue;
    const dimension = metric.dimensions.find((candidate) => candidate.table === table && candidate.joinPath);
    if (!dimension?.joinPath || joined.has(dimension.joinPath)) continue;
    const edge = metric.joinGraph.find((candidate) => candidate.name === dimension.joinPath);
    if (!edge) continue;
    joins.push(
      `JOIN ${q(edge.to)} ON ${q(edge.from)}.${q(edge.fromKey)} = ${q(edge.to)}.${q(edge.toKey)}`,
    );
    joined.add(edge.name);
  }

  const rawFormula = metric.formula!;
  if (!/^[A-Za-z0-9_+*/().\s-]+$/.test(rawFormula)) {
    return { ok: false, reason: `派生指标 ${metric.metric} formula 包含不安全字符` };
  }
  const dependencyNames = new Set(resolved.map((dependency) => dependency.metric));
  const unknownFormulaNames = rawFormula
    .match(/[A-Za-z_][A-Za-z0-9_]*/g)
    ?.filter((token) => !dependencyNames.has(token) && !["SUM", "AVG", "MIN", "MAX", "COUNT"].includes(token.toUpperCase()));
  if (unknownFormulaNames?.length) {
    return { ok: false, reason: `派生指标 ${metric.metric} formula 包含未解析标识符` };
  }

  const expressions = new Map(
    resolved.map((dependency) => [dependency.metric, metricMeasureExpression(dependency, q)]),
  );
  const compiledFormula = compileMetricFormula(rawFormula, expressions);
  if (!compiledFormula.ok) {
    return { ok: false, reason: `Derived metric formula failed: ${compiledFormula.reason}` };
  }
  select.push(`${compiledFormula.sql} AS ${q(metric.metric)}`);

  let sql = `SELECT ${select.join(", ")} FROM ${q(metric.factTable)}`;
  if (joins.length) sql += ` ${joins.join(" ")}`;
  const where: string[] = [];
  for (const filter of filters) {
    const field = filter.field.includes(".")
      ? filter.field.split(".").map((part) => q(part)).join(".")
      : `${q(metric.factTable)}.${q(filter.field)}`;
    if (filter.operator === "in" || filter.operator === "not_in") {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (values.length === 0) return { ok: false, reason: "in/not_in 过滤器不能为空" };
      params.push(...values.map((value) => (typeof value === "boolean" ? Number(value) : value)));
      where.push(`${field} ${filter.operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`);
    } else {
      params.push(
        typeof filter.value === "boolean"
          ? Number(filter.value)
          : Array.isArray(filter.value)
            ? String(filter.value[0])
            : filter.value,
      );
      where.push(`${field} ${filter.operator} ?`);
    }
  }
  if (request.timeRange) {
    const timeField = `${q(metric.factTable)}.${q(metric.timeDimension)}`;
    where.push(`${timeField} >= ?`);
    params.push(request.timeRange.from);
    where.push(`${timeField} <= ?`);
    params.push(request.timeRange.to);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  if (groupBy.length) sql += ` GROUP BY ${groupBy.join(", ")}`;
  if (timeBucket) sql += ` ORDER BY ${timeBucket} ASC`;
  if (request.limit !== undefined) sql += ` ${renderPagination(dialect, request.limit, 0)}`;

  return {
    ok: true,
    sql,
    params,
    dialectFamily: dialect,
    logicalQuery: {
      source: metric.datasourceId,
      metricId: metric.metric,
      measures: resolved.map((dependency) => ({
        ref: `${dependency.factTable}.${dependency.measure.field}`,
        aggregation: dependency.measure.aggregation,
      })),
      dimensions: selectedDims.map((name) => {
        const dimension = metric.dimensions.find((candidate) => candidate.name === name)!;
        return { ref: `${dimension.table}.${dimension.column}` };
      }),
      filters,
      timeRange: request.timeRange
        ? {
            ...request.timeRange,
            field: `${metric.factTable}.${metric.timeDimension}`,
            timezone: request.timeRange.timezone || metric.timezone,
          }
        : undefined,
      timeGrain: request.timeGrain
        ? {
            field: `${metric.factTable}.${metric.timeDimension}`,
            grain: request.timeGrain,
          }
        : undefined,
      limit: request.limit,
    },
  };
}

function metricMeasureExpression(
  metric: MetricDefinition,
  q: (name: string) => string,
): string {
  const field = `${q(metric.factTable)}.${q(metric.measure.field)}`;
  switch (metric.measure.aggregation) {
    case "count":
      return `COUNT(${field})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${field})`;
    default:
      return `${metric.measure.aggregation.toUpperCase()}(${field})`;
  }
}

function compileMetricFormula(
  formula: string,
  expressions: Map<string, string>,
): { ok: true; sql: string } | { ok: false; reason: string } {
  const tokens = formula.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join("") !== formula.replace(/\s+/g, "")) {
    return { ok: false, reason: "contains unsupported tokens" };
  }
  let cursor = 0;

  const parseExpression = (): string => {
    let left = parseTerm();
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const operator = tokens[cursor++]!;
      const right = parseTerm();
      left = `(${left} ${operator} ${right})`;
    }
    return left;
  };

  const parseTerm = (): string => {
    let left = parseFactor();
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const operator = tokens[cursor++]!;
      const right = parseFactor();
      left = operator === "/"
        ? `(${left} / NULLIF(${right}, 0))`
        : `(${left} * ${right})`;
    }
    return left;
  };

  const parseFactor = (): string => {
    const token = tokens[cursor++];
    if (!token) throw new Error("unexpected end of formula");
    if (token === "(") {
      const nested = parseExpression();
      if (tokens[cursor++] !== ")") throw new Error("missing closing parenthesis");
      return `(${nested})`;
    }
    if (token === "-") return `(-${parseFactor()})`;
    if (/^\d+(?:\.\d+)?$/.test(token)) return token;
    const expression = expressions.get(token);
    if (!expression) throw new Error(`unknown dependency ${token}`);
    return `(${expression})`;
  };

  try {
    const sql = parseExpression();
    if (cursor !== tokens.length) {
      return { ok: false, reason: `unexpected token ${tokens[cursor]}` };
    }
    return { ok: true, sql };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function detectFanout(
  metric: MetricDefinition,
  dimensions: string[],
): string | null {
  for (const name of dimensions) {
    const dim = metric.dimensions.find((d) => d.name === name);
    if (!dim?.joinPath) continue;
    const edge = metric.joinGraph.find((j) => j.name === dim.joinPath);
    if (!edge) {
      return `维度 ${name} 缺少 joinPath 定义`;
    }
    if (edge.cardinality === "many_to_many" || edge.cardinality === "one_to_many") {
      if (edge.from === metric.factTable && edge.cardinality === "one_to_many") {
        return `维度 ${name} 存在一对多 fanout，拒绝编译以保证口径`;
      }
      if (edge.cardinality === "many_to_many") {
        return `维度 ${name} 存在多对多 fanout，拒绝编译以保证口径`;
      }
    }
  }
  return null;
}

function compileWithJoins(
  metric: MetricDefinition,
  dimensions: string[],
  filters: FilterExpression[],
  request: MetricCompileRequest,
  dialect: DialectFamily,
): MetricCompileResult {
  const q = (name: string) => quoteIdentifier(dialect, name);
  const select: string[] = [];
  const groupBy: string[] = [];
  const joins: string[] = [];
  const joined = new Set<string>();
  const params: (string | number)[] = [];

  const timeBucket = request.timeGrain
    ? renderTimeBucket(
        dialect,
        `${q(metric.factTable)}.${q(metric.timeDimension)}`,
        request.timeGrain,
      )
    : undefined;
  if (timeBucket && request.timeGrain) {
    select.push(
      `${timeBucket} AS ${q(`time_${request.timeGrain}`)}`,
    );
    groupBy.push(timeBucket);
  }

  for (const name of dimensions) {
    const dim = metric.dimensions.find((d) => d.name === name)!;
    const expr = `${q(dim.table)}.${q(dim.column)}`;
    select.push(`${expr} AS ${q(dim.name)}`);
    groupBy.push(expr);
    if (dim.joinPath && !joined.has(dim.joinPath)) {
      const edge = metric.joinGraph.find((j) => j.name === dim.joinPath)!;
      joins.push(
        `JOIN ${q(edge.to)} ON ${q(edge.from)}.${q(edge.fromKey)} = ${q(edge.to)}.${q(edge.toKey)}`,
      );
      joined.add(dim.joinPath);
    }
  }

  // Filters on joined entities need the same join even when the entity is not
  // selected as a visible dimension, e.g. "Alice's sales".
  for (const filter of filters) {
    const table = filter.field.split(".", 2)[0];
    if (!table || table === metric.factTable) continue;
    const dim = metric.dimensions.find(
      (candidate) => candidate.table === table && candidate.joinPath,
    );
    if (!dim?.joinPath || joined.has(dim.joinPath)) continue;
    const edge = metric.joinGraph.find((candidate) => candidate.name === dim.joinPath);
    if (!edge) continue;
    joins.push(
      `JOIN ${q(edge.to)} ON ${q(edge.from)}.${q(edge.fromKey)} = ${q(edge.to)}.${q(edge.toKey)}`,
    );
    joined.add(edge.name);
  }

  const agg = metric.measure.aggregation.toUpperCase();
  const measureExpr =
    metric.measure.aggregation === "count"
      ? `COUNT(${q(metric.factTable)}.${q(metric.measure.field)})`
      : metric.measure.aggregation === "count_distinct"
        ? `COUNT(DISTINCT ${q(metric.factTable)}.${q(metric.measure.field)})`
        : `${agg}(${q(metric.factTable)}.${q(metric.measure.field)})`;
  select.push(`${measureExpr} AS ${q(metric.metric)}`);

  let sql = `SELECT ${select.join(", ")} FROM ${q(metric.factTable)}`;
  if (joins.length) sql += ` ${joins.join(" ")}`;

  const where: string[] = [];
  for (const f of filters) {
    const field = f.field.includes(".")
      ? f.field
          .split(".")
          .map((p) => q(p))
          .join(".")
      : `${q(metric.factTable)}.${q(f.field)}`;
    if (f.operator === "in" || f.operator === "not_in") {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      const ph = values.map(() => "?").join(", ");
      params.push(...values.map((v) => (typeof v === "boolean" ? Number(v) : v)));
      where.push(
        `${field} ${f.operator === "in" ? "IN" : "NOT IN"} (${ph})`,
      );
    } else {
      params.push(
        typeof f.value === "boolean"
          ? Number(f.value)
          : Array.isArray(f.value)
            ? String(f.value[0])
            : f.value,
      );
      where.push(`${field} ${f.operator} ?`);
    }
  }

  if (request.timeRange) {
    const col = `${q(metric.factTable)}.${q(metric.timeDimension)}`;
    where.push(`${col} >= ?`);
    params.push(request.timeRange.from);
    where.push(`${col} <= ?`);
    params.push(request.timeRange.to);
  }

  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  if (groupBy.length) sql += ` GROUP BY ${groupBy.join(", ")}`;
  if (timeBucket) sql += ` ORDER BY ${timeBucket} ASC`;
  if (request.limit !== undefined) {
    sql += ` ${renderPagination(dialect, request.limit, 0)}`;
  }

  const logicalQuery: LogicalQuery = {
    source: metric.datasourceId,
    metricId: metric.metric,
    measures: [
      {
        ref: `${metric.factTable}.${metric.measure.field}`,
        aggregation: metric.measure.aggregation,
      },
    ],
    dimensions: dimensions.map((name) => {
      const dim = metric.dimensions.find((d) => d.name === name)!;
      return { ref: `${dim.table}.${dim.column}` };
    }),
    filters,
    timeRange: request.timeRange
      ? {
          ...request.timeRange,
          field: `${metric.factTable}.${metric.timeDimension}`,
          timezone: request.timeRange.timezone || metric.timezone,
        }
      : undefined,
    timeGrain: request.timeGrain
      ? {
          field: `${metric.factTable}.${metric.timeDimension}`,
          grain: request.timeGrain,
        }
      : undefined,
    limit: request.limit,
  };

  return { ok: true, logicalQuery, sql, params, dialectFamily: dialect };
}
