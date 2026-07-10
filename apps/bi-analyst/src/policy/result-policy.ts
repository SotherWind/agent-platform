import type { ExecutionResult } from "../entities.js";
import type { AccessPolicy } from "../policy/access-policy.js";

export interface ResultPolicyOptions {
  /** 分组结果最小人数，低于此值拒绝或合并 */
  minAggregationCount?: number;
  maxRows?: number;
  maxColumns?: number;
  maxResponseBytes?: number;
  /** 需要掩码的列 */
  maskColumns?: Array<{
    column: string;
    strategy: "deny" | "hash" | "partial";
  }>;
}

export interface ResultPolicyContext {
  accessPolicy?: AccessPolicy | null;
  options?: ResultPolicyOptions;
}

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_COLUMNS = 50;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 返回前防泄漏：列掩码、行数/体积限制、最小聚合人数 */
export function applyResultPolicy(
  result: ExecutionResult,
  ctx: ResultPolicyContext = {},
): ExecutionResult {
  if (result.error || result.isEmpty) {
    return result;
  }

  const opts = ctx.options ?? {};
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = opts.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES;

  let rows = [...result.rows];
  let columns = [...result.columns];
  const warnings = [...(result.warnings ?? [])];

  // 列级掩码
  const maskRules = [
    ...(opts.maskColumns ?? []),
    ...(ctx.accessPolicy?.maskRules?.map((r) => ({
      column: r.column,
      strategy: r.strategy,
    })) ?? []),
  ];

  const deniedColumns = new Set<string>();
  for (const rule of maskRules) {
    if (rule.strategy === "deny") {
      deniedColumns.add(rule.column);
    }
  }

  if (deniedColumns.size > 0) {
    columns = columns.filter((c) => !deniedColumns.has(c));
    rows = rows.map((row) => {
      const filtered: Record<string, unknown> = {};
      for (const col of columns) {
        filtered[col] = row[col];
      }
      return filtered;
    });
    warnings.push(`已移除 ${deniedColumns.size} 个禁止列`);
  }

  for (const rule of maskRules) {
    if (!columns.includes(rule.column)) continue;
    if (rule.strategy === "deny") continue;
    const strategy = rule.strategy;
    rows = rows.map((row) => ({
      ...row,
      [rule.column]: maskValue(row[rule.column], strategy),
    }));
  }

  // 行数限制
  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    warnings.push(`结果已截断至 ${maxRows} 行`);
  }

  // 列数限制
  if (columns.length > maxColumns) {
    columns = columns.slice(0, maxColumns);
    rows = rows.map((row) => {
      const trimmed: Record<string, unknown> = {};
      for (const col of columns) {
        trimmed[col] = row[col];
      }
      return trimmed;
    });
    warnings.push(`列数已截断至 ${maxColumns}`);
  }

  // 响应体大小
  const serialized = JSON.stringify({ rows, columns });
  if (serialized.length > maxBytes) {
    const ratio = maxBytes / serialized.length;
    const targetRows = Math.max(1, Math.floor(rows.length * ratio));
    rows = rows.slice(0, targetRows);
    warnings.push(`响应体过大，已截断至 ${targetRows} 行`);
  }

  // 最小聚合人数（若存在 count 类列）
  if (opts.minAggregationCount && opts.minAggregationCount > 1) {
    const countCol = columns.find((c) => /count|cnt|num|人数/i.test(c));
    if (countCol) {
      rows = rows.filter((row) => {
        const val = Number(row[countCol]);
        return Number.isNaN(val) || val >= opts.minAggregationCount!;
      });
      if (rows.length === 0) {
        return {
          rows: [],
          columns: [],
          isEmpty: true,
          warnings: [
            ...(warnings ?? []),
            `分组人数低于最小聚合阈值 ${opts.minAggregationCount}`,
          ],
        };
      }
    }
  }

  return {
    ...result,
    rows,
    columns,
    isEmpty: rows.length === 0,
    warnings: warnings.length > 0 ? warnings : result.warnings,
    stats: result.stats
      ? { ...result.stats, rowCount: rows.length }
      : result.stats,
  };
}

function maskValue(
  value: unknown,
  strategy: "hash" | "partial",
): unknown {
  if (value === null || value === undefined) return value;
  const str = String(value);
  if (strategy === "hash") {
    return `***${simpleHash(str)}`;
  }
  if (str.length <= 4) return "****";
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}
