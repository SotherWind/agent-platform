import type { ExecutionResult } from "../entities.js";
import type { AccessPolicy } from "../policy/access-policy.js";

export type MaskStrategy = "deny" | "hash" | "partial";

/** 列值语义类型：影响 hash/partial 的呈现方式 */
export type MaskValueType =
  | "string"
  | "number"
  | "boolean"
  | "email"
  | "phone"
  | "date"
  | "object";

export interface MaskColumnRule {
  column: string;
  strategy: MaskStrategy;
  /** 可选：覆盖自动推断的类型 */
  valueType?: MaskValueType;
  table?: string;
}

export interface ResultPolicyOptions {
  /** 分组结果最小人数，低于此值拒绝或合并 */
  minAggregationCount?: number;
  aggregationCountColumns?: string[];
  enforceAggregationCount?: boolean;
  maxRows?: number;
  maxColumns?: number;
  maxResponseBytes?: number;
  /** 需要掩码的列 */
  maskColumns?: MaskColumnRule[];
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

  // SQL aggregate functions such as SUM/AVG/MIN/MAX emit one row containing
  // only NULL values when their input set is empty. Treat that sentinel row as
  // an empty result so charts, answers, history and exports agree on the
  // no-data state instead of exposing a misleading single `null` value.
  if (isNullOnlySentinelRow(result)) {
    return {
      ...result,
      rows: [],
      columns: [],
      isEmpty: true,
      stats: result.stats ? { ...result.stats, rowCount: 0 } : result.stats,
    };
  }

  const opts = ctx.options ?? {};
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = opts.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES;

  let rows = [...result.rows];
  let columns = [...result.columns];
  const warnings = [...(result.warnings ?? [])];
  const degradationReasons = [...(result.degradationReasons ?? [])];
  const markDegraded = (reason: string, warning: string) => {
    if (!degradationReasons.includes(reason)) degradationReasons.push(reason);
    if (!warnings.includes(warning)) warnings.push(warning);
  };
  const sourceRowCount = rows.length;
  const sourceColumnCount = columns.length;

  const maskRules: MaskColumnRule[] = [
    ...(opts.maskColumns ?? []),
    ...(ctx.accessPolicy?.maskRules?.map((r) => ({
      column: r.column,
      strategy: r.strategy,
      table: r.table,
      valueType: (r as { valueType?: MaskValueType }).valueType,
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
      [rule.column]: maskValue(row[rule.column], strategy, {
        column: rule.column,
        valueType: rule.valueType,
      }),
    }));
  }

  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    warnings.push(`结果已截断至 ${maxRows} 行`);
  }

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

  const serializedBytesBeforeBudget = Buffer.byteLength(
    JSON.stringify({ rows, columns }),
    "utf8",
  );
  if (serializedBytesBeforeBudget > maxBytes) {
    const ratio = maxBytes / serializedBytesBeforeBudget;
    const targetRows = Math.max(1, Math.floor(rows.length * ratio));
    rows = rows.slice(0, targetRows);
    warnings.push(`响应体过大，已截断至 ${targetRows} 行`);
  }

  if (sourceRowCount > maxRows) {
    markDegraded("maxRows", `结果已截断至 ${maxRows} 行`);
  }
  if (sourceColumnCount > maxColumns) {
    markDegraded("maxColumns", `列数已截断至 ${maxColumns}`);
  }

  if (serializedBytesBeforeBudget > maxBytes) {
    markDegraded("maxResponseBytes", `response exceeded ${maxBytes} bytes and was reduced`);
  }

  const fitted = fitResponseToByteBudget(rows, columns, maxBytes);
  rows = fitted.rows;
  columns = fitted.columns;
  if (fitted.changed) {
    markDegraded(
      "maxResponseBytes",
      `响应体超过 ${maxBytes} bytes，已降级为 ${rows.length} 行/${columns.length} 列`,
    );
  }

  if (opts.minAggregationCount && opts.minAggregationCount > 1) {
    const requested = new Set(
      (opts.aggregationCountColumns ?? []).map((column) => column.toLowerCase()),
    );
    const countCol = columns.find(
      (column) =>
        requested.has(column.toLowerCase()) ||
        /count|cnt|num|人数/i.test(column),
    );
    if (!countCol && opts.enforceAggregationCount) {
      return {
        ...result,
        rows: [],
        columns: [],
        isEmpty: true,
        warnings: [
          ...warnings,
          "Aggregate result did not expose a verifiable count column",
        ],
        degraded: true,
        degradationReasons: [...degradationReasons, "minAggregationCount"],
      };
    }
    if (countCol) {
      const beforeCountFilter = rows.length;
      rows = rows.filter((row) => {
        const val = Number(row[countCol]);
        return Number.isFinite(val) && val >= opts.minAggregationCount!;
      });
      if (rows.length < beforeCountFilter) {
        markDegraded(
          "minAggregationCount",
          `rows below minimum aggregation count ${opts.minAggregationCount} were removed`,
        );
      }
      if (rows.length === 0) {
        return {
          ...result,
          rows: [],
          columns: [],
          isEmpty: true,
          warnings: [
            ...(warnings ?? []),
            `分组人数低于最小聚合阈值 ${opts.minAggregationCount}`,
          ],
          degraded: true,
          degradationReasons: [...degradationReasons, "minAggregationCount"],
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
    degraded: Boolean(result.degraded) || degradationReasons.length > 0 || undefined,
    degradationReasons:
      degradationReasons.length > 0 ? degradationReasons : result.degradationReasons,
    stats: result.stats
      ? { ...result.stats, rowCount: rows.length }
      : result.stats,
  };
}

/** Identify COUNT projection aliases for post-query privacy enforcement. */
export function extractAggregationCountColumns(sql: string): string[] {
  const sanitized = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  const aliases: string[] = [];
  const pattern = /\bcount\s*\([^)]*\)(?:\s+as\s+|\s+)([A-Za-z_][A-Za-z0-9_$]*)/gi;
  for (const match of sanitized.matchAll(pattern)) {
    if (match[1]) aliases.push(match[1]);
  }
  return aliases;
}

export function isAggregationQuery(sql: string): boolean {
  const sanitized = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  return /\b(?:count|sum|avg|min|max)\s*\(/i.test(sanitized) ||
    /\bgroup\s+by\b/i.test(sanitized);
}

function isNullOnlySentinelRow(result: ExecutionResult): boolean {
  if (result.rows.length !== 1 || result.columns.length === 0) return false;
  const row = result.rows[0]!;
  return result.columns.every((column) => row[column] === null || row[column] === undefined);
}

function fitResponseToByteBudget(
  rows: Record<string, unknown>[],
  columns: string[],
  maxBytes: number,
): { rows: Record<string, unknown>[]; columns: string[]; changed: boolean } {
  const originalRows = rows.length;
  const originalColumns = columns.length;
  const byteLength = (r: Record<string, unknown>[], c: string[]) =>
    Buffer.byteLength(JSON.stringify({ rows: r, columns: c }), "utf8");

  while (rows.length > 0 && byteLength(rows, columns) > maxBytes) {
    rows = rows.slice(0, -1);
  }
  while (columns.length > 0 && byteLength(rows, columns) > maxBytes) {
    columns = columns.slice(0, -1);
    rows = rows.map((row) => {
      const trimmed: Record<string, unknown> = {};
      for (const col of columns) trimmed[col] = row[col];
      return trimmed;
    });
  }
  if (byteLength(rows, columns) > maxBytes) {
    rows = [];
    columns = [];
  }
  return {
    rows,
    columns,
    changed: rows.length !== originalRows || columns.length !== originalColumns,
  };
}

export function inferMaskValueType(
  value: unknown,
  column?: string,
): MaskValueType {
  if (value === null || value === undefined) return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    if (column && /phone|mobile|tel/i.test(column)) return "phone";
    return "number";
  }
  if (value instanceof Date) return "date";
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    if (column && /email|mail/i.test(column)) return "email";
    if (column && /phone|mobile|tel/i.test(column)) return "phone";
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return "email";
    if (/^\+?\d{7,15}$/.test(value.replace(/[\s-]/g, ""))) return "phone";
    return "string";
  }
  return "string";
}

/** 类型感知掩码：number/boolean/email/phone/object 分支处理 */
export function maskValue(
  value: unknown,
  strategy: "hash" | "partial",
  hint?: { column?: string; valueType?: MaskValueType },
): unknown {
  if (value === null || value === undefined) return value;

  const valueType =
    hint?.valueType ?? inferMaskValueType(value, hint?.column);

  if (strategy === "hash") {
    return maskHash(value, valueType);
  }
  return maskPartial(value, valueType);
}

function maskHash(value: unknown, valueType: MaskValueType): string {
  if (valueType === "boolean") return "***bool";
  if (valueType === "number") {
    return `***n${simpleHash(String(value))}`;
  }
  if (valueType === "object") {
    return `***obj${simpleHash(stableStringify(value))}`;
  }
  if (valueType === "date") {
    const iso =
      value instanceof Date ? value.toISOString() : String(value);
    return `***d${simpleHash(iso)}`;
  }
  return `***${simpleHash(String(value))}`;
}

function maskPartial(value: unknown, valueType: MaskValueType): unknown {
  switch (valueType) {
    case "boolean":
      return "***";
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return "****";
      // 保留数量级，隐藏精确值（如 13800000000 → 1********）
      const abs = Math.abs(Math.trunc(n));
      const s = String(abs);
      if (s.length <= 2) return "****";
      return `${s[0]}${"*".repeat(s.length - 1)}`;
    }
    case "email": {
      const str = String(value);
      const at = str.indexOf("@");
      if (at <= 0) return partialString(str);
      const local = str.slice(0, at);
      const domain = str.slice(at + 1);
      const localMasked =
        local.length <= 1 ? "*" : `${local[0]}***`;
      return `${localMasked}@${domain}`;
    }
    case "phone": {
      const digits = String(value).replace(/\D/g, "");
      if (digits.length < 7) return "****";
      return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
    }
    case "date": {
      const iso =
        value instanceof Date ? value.toISOString() : String(value);
      // 保留年月，隐藏日
      const m = /^(\d{4}-\d{2})-/.exec(iso);
      if (m) return `${m[1]}-**`;
      return partialString(iso);
    }
    case "object":
      return "***";
    case "string":
    default:
      return partialString(String(value));
  }
}

function partialString(str: string): string {
  if (str.length <= 4) return "****";
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}
