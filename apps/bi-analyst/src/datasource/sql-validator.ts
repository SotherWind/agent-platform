import type { DialectFamily } from "./types.js";

export interface SqlValidatorOptions {
  dialectFamily?: DialectFamily;
  maxRows?: number;
  maxJoins?: number;
  maxCteDepth?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
}

export interface SqlValidationResult {
  valid: boolean;
  reason?: string;
  /** 若原 SQL 无 LIMIT，返回包裹后的 SQL */
  normalizedSql?: string;
}

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_JOINS = 10;

/** 禁止的语句类型（副作用 / DDL / DML） */
const FORBIDDEN_STATEMENT_PATTERNS = [
  /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL|DO|COPY|LOAD|ATTACH|DETACH|PRAGMA\s+(?!table_info|foreign_key_list))/i,
];

/** 禁止的危险函数 / 副作用 SELECT 模式 */
const DANGEROUS_PATTERNS = [
  /\bINTO\s+(OUTFILE|DUMPFILE|SOME\s+TABLE)\b/i,
  /\bSELECT\b[\s\S]*?\bINTO\b/i,
  /\bpg_read_file\b/i,
  /\bpg_write_file\b/i,
  /\bload_file\s*\(/i,
  /\bsystem\s*\(/i,
  /\bxp_cmdshell\b/i,
  /\bsp_executesql\b/i,
  /\bopenrowset\b/i,
  /\bopendatasource\b/i,
  /\bexec\s*\(/i,
  /\bpragma\s+(?!table_info|foreign_key_list)/i,
];

/** 移除 SQL 注释 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** 检测多语句 */
function hasMultipleStatements(sql: string): boolean {
  const stripped = stripComments(sql).trim();
  const withoutStrings = stripped.replace(/'(?:''|[^'])*'/g, "''");
  const parts = withoutStrings.split(";").filter((p) => p.trim().length > 0);
  return parts.length > 1;
}

/** 检测是否为只读 SELECT / WITH 查询 */
function isReadOnlyQuery(sql: string): boolean {
  const normalized = stripComments(sql).trim();
  return /^(WITH|SELECT)\b/i.test(normalized);
}

/** 移除字符串字面量，避免误判列名/常量 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

/** 检测 CTE / 子查询内嵌的破坏性语句（不仅检查开头） */
function containsDestructiveKeywords(sql: string): boolean {
  const stripped = stripStringLiterals(stripComments(sql));
  return /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|ATTACH|DETACH)\b/i.test(
    stripped,
  );
}

function countJoins(sql: string): number {
  const matches = stripComments(sql).match(/\bJOIN\b/gi);
  return matches?.length ?? 0;
}

function hasLimitClause(sql: string): boolean {
  return /\bLIMIT\s+\d+/i.test(stripComments(sql));
}

/** 为无 LIMIT 的 SELECT 自动包裹行数限制 */
function wrapWithLimit(sql: string, maxRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (hasLimitClause(trimmed)) {
    return trimmed;
  }
  return `SELECT * FROM (${trimmed}) AS __limited__ LIMIT ${maxRows}`;
}

/** 方言 AST 校验（Phase 0：基于规则；Phase 2+ 可接入完整 AST 解析器） */
export function validateSql(
  sql: string,
  options: SqlValidatorOptions = {},
): SqlValidationResult {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxJoins = options.maxJoins ?? DEFAULT_MAX_JOINS;

  if (!sql || sql.trim().length === 0) {
    return { valid: false, reason: "SQL 不能为空" };
  }

  if (hasMultipleStatements(sql)) {
    return { valid: false, reason: "禁止多语句执行" };
  }

  for (const pattern of FORBIDDEN_STATEMENT_PATTERNS) {
    if (pattern.test(stripComments(sql))) {
      return { valid: false, reason: "禁止非 SELECT 或副作用语句" };
    }
  }

  if (!isReadOnlyQuery(sql)) {
    return { valid: false, reason: "仅允许 SELECT / WITH 只读查询" };
  }

  if (containsDestructiveKeywords(sql)) {
    return { valid: false, reason: "禁止非 SELECT 或副作用语句" };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sql)) {
      return { valid: false, reason: "检测到危险函数或副作用 SELECT" };
    }
  }

  if (countJoins(sql) > maxJoins) {
    return { valid: false, reason: `JOIN 数量超过限制 (${maxJoins})` };
  }

  if (options.allowedTables?.length) {
    const tableViolation = checkTableAccess(sql, options.allowedTables);
    if (tableViolation) {
      return { valid: false, reason: tableViolation };
    }
  }

  const normalizedSql = wrapWithLimit(sql, maxRows);
  return { valid: true, normalizedSql };
}

/** 简单表名提取与越权检查 */
function checkTableAccess(sql: string, allowedTables: string[]): string | null {
  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  const fromPattern =
    /\b(?:FROM|JOIN)\s+(?:`?(\w+)`?|"(\w+)"|\[(\w+)\]|(\w+))/gi;
  let match: RegExpExecArray | null;
  const stripped = stripComments(sql);

  while ((match = fromPattern.exec(stripped)) !== null) {
    const table = (match[1] ?? match[2] ?? match[3] ?? match[4])?.toLowerCase();
    if (table && !allowed.has(table)) {
      return `无权访问表: ${table}`;
    }
  }
  return null;
}

export { DEFAULT_MAX_ROWS, DEFAULT_MAX_JOINS };
