import type { AccessPolicy } from "../policy/access-policy.js";
import { timeRangeClarificationOptions } from "../semantic/calendar.js";
import type { LogicalQuery } from "./logical-query.js";
import type { ClarificationRequest } from "./clarification.js";

export interface PolicyPlanValidationResult {
  ok: boolean;
  reason?: string;
  clarification?: ClarificationRequest;
}

/** 在生成 SQL 前于逻辑层校验权限、范围与必要时间 */
export function validateLogicalQueryPolicy(
  query: LogicalQuery,
  policy: AccessPolicy,
  options?: {
    requireTimeRange?: boolean;
    authorizedMetricIds?: string[];
  },
): PolicyPlanValidationResult {
  if (!policy.allowedDataSourceIds.includes(query.source)) {
    return { ok: false, reason: `无权访问数据源: ${query.source}` };
  }

  if (query.metricId && options?.authorizedMetricIds) {
    if (!options.authorizedMetricIds.includes(query.metricId)) {
      return { ok: false, reason: `未授权指标: ${query.metricId}` };
    }
  }

  const fields = [
    ...query.filters.map((f) => f.field),
    ...(query.timeRange ? [query.timeRange.field] : []),
    ...(query.timeGrain ? [query.timeGrain.field] : []),
  ];

  for (const field of fields) {
    const [table, column] = splitField(field);
    if (table && policy.deniedTables?.includes(table)) {
      return { ok: false, reason: `无权访问表: ${table}` };
    }
    if (table && policy.allowedTables?.length && !policy.allowedTables.includes(table)) {
      return { ok: false, reason: `无权访问表: ${table}` };
    }
    if (table && column && policy.allowedColumns?.[table]) {
      if (!policy.allowedColumns[table]!.includes(column)) {
        return { ok: false, reason: `无权访问列: ${table}.${column}` };
      }
    }
  }

  if (options?.requireTimeRange && !query.timeRange) {
    return {
      ok: false,
      clarification: {
        reason: "missing_time_range",
        question: "请指定分析的时间范围",
        options: timeRangeClarificationOptions(),
      },
    };
  }

  return { ok: true };
}

function splitField(field: string): [string | null, string] {
  const parts = field.split(".");
  if (parts.length >= 2) {
    return [parts[0]!, parts.slice(1).join(".")];
  }
  return [null, field];
}
