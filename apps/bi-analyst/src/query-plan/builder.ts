import type { AccessPolicy } from "../policy/access-policy.js";
import type { RetrievedSchema } from "../metadata/types.js";
import {
  LogicalQuerySchema,
  type LogicalQuery,
  type FilterExpression,
} from "./logical-query.js";

export interface BuildLogicalQueryInput {
  source: string;
  measures?: LogicalQuery["measures"];
  dimensions?: LogicalQuery["dimensions"];
  filters?: FilterExpression[];
  timeRange?: LogicalQuery["timeRange"];
  timeGrain?: LogicalQuery["timeGrain"];
  orderBy?: LogicalQuery["orderBy"];
  limit?: number;
  metricId?: string;
  /** RAG 检索后的授权 schema；用于校验 ref 合法性 */
  schema?: RetrievedSchema | null;
  policy?: AccessPolicy | null;
}

export interface BuildLogicalQueryResult {
  ok: boolean;
  query?: LogicalQuery;
  reason?: string;
}

/** 从结构化输入构建 LogicalQuery；仅允许引用 schema/policy 授权对象 */
export function buildLogicalQuery(
  input: BuildLogicalQueryInput,
): BuildLogicalQueryResult {
  const parsed = LogicalQuerySchema.safeParse({
    source: input.source,
    measures: input.measures ?? [],
    dimensions: input.dimensions ?? [],
    filters: input.filters ?? [],
    timeRange: input.timeRange,
    timeGrain: input.timeGrain,
    orderBy: input.orderBy,
    limit: input.limit,
    metricId: input.metricId,
  });
  if (!parsed.success) {
    return { ok: false, reason: `LogicalQuery 校验失败: ${parsed.error.message}` };
  }

  const query = parsed.data;

  if (input.policy?.allowedDataSourceIds?.length) {
    if (!input.policy.allowedDataSourceIds.includes(query.source)) {
      return { ok: false, reason: `无权访问数据源: ${query.source}` };
    }
  }

  if (input.schema) {
    const allowedRefs = collectAuthorizedRefs(input.schema, input.policy);
    const refs = [
      ...query.measures.map((m) => m.ref),
      ...query.dimensions.map((d) => d.ref),
      ...query.filters.map((f) => f.field),
      ...(query.timeRange ? [query.timeRange.field] : []),
      ...(query.orderBy ?? []).map((o) => o.ref),
    ];
    for (const ref of refs) {
      if (!allowedRefs.has(normalizeRef(ref))) {
        return { ok: false, reason: `未授权或未知逻辑对象: ${ref}` };
      }
    }
  }

  return { ok: true, query };
}

function normalizeRef(ref: string): string {
  return ref.replace(/^[^.]+\./, "").toLowerCase() === ref.toLowerCase()
    ? ref.toLowerCase()
    : ref.toLowerCase();
}

function collectAuthorizedRefs(
  schema: RetrievedSchema,
  policy?: AccessPolicy | null,
): Set<string> {
  const refs = new Set<string>();
  for (const table of schema.tables) {
    if (policy?.allowedTables?.length && !policy.allowedTables.includes(table.name)) {
      continue;
    }
    if (policy?.deniedTables?.includes(table.name)) continue;
    refs.add(table.name.toLowerCase());
    for (const col of table.columns) {
      if (
        policy?.allowedColumns?.[table.name] &&
        !policy.allowedColumns[table.name]!.includes(col.name)
      ) {
        continue;
      }
      refs.add(col.name.toLowerCase());
      refs.add(`${table.name}.${col.name}`.toLowerCase());
    }
  }
  return refs;
}
