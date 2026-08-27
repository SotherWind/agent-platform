import SqlParser from "node-sql-parser";
import type { TypedPolicyPredicate } from "./access-policy.js";
import { validateSql } from "../datasource/sql-validator.js";
import type { SqlValidatorOptions } from "../datasource/sql-validator.js";
import { toDialectPlaceholders } from "../datasource/placeholders.js";
import type { DialectFamily } from "../datasource/types.js";

const { Parser } = SqlParser;
const parser = new Parser();

type AstRecord = Record<string, unknown>;

export interface RowFilterRewriteResult {
  ok: boolean;
  sql?: string;
  params?: (string | number)[];
  reason?: string;
}

interface DirectTableReference {
  table: string;
  qualifier: string;
}

interface SqlToken {
  word: string;
  start: number;
  end: number;
}

/**
 * Applies typed row filters only when the SQL AST proves the query has one
 * top-level SELECT scope. CTEs, set operations and every form of subquery are
 * rejected fail-closed until all SELECT scopes can be rewritten independently.
 */
export function applyRowFilters(
  sql: string,
  predicates: TypedPolicyPredicate[] | undefined,
  validatorOptions: SqlValidatorOptions = {},
): RowFilterRewriteResult {
  if (!predicates?.length) {
    return { ok: true, sql, params: [] };
  }

  const stripped = sql.trim().replace(/;\s*$/, "");
  const astResult = inspectSingleSelect(stripped, validatorOptions.dialectFamily);
  if (!astResult.ok) return astResult;

  const params: (string | number)[] = [];
  const clauses: string[] = [];

  for (const predicate of predicates) {
    if (!isSafeIdentifier(predicate.table)) {
      return { ok: false, reason: `Invalid policy table: ${predicate.table}` };
    }
    if (!isSafeIdentifier(predicate.column)) {
      return { ok: false, reason: `Invalid policy column: ${predicate.column}` };
    }

    const references = astResult.tables.filter(
      (reference) => reference.table === predicate.table.toLowerCase(),
    );
    for (const reference of references) {
      const columnRef = `${reference.qualifier}.${predicate.column}`;
      const clause = predicateClause(columnRef, predicate, params);
      if (!clause.ok) return clause;
      clauses.push(clause.sql);
    }
  }

  // A table name appearing only inside a comment or string literal must not
  // cause a predicate to be injected into an unrelated query.
  if (clauses.length === 0) {
    return { ok: true, sql: stripped, params: [] };
  }

  const rewritten = injectTopLevelWhere(stripped, clauses.join(" AND "));
  if (!rewritten) {
    return {
      ok: false,
      reason: "Unable to locate a safe top-level SELECT clause for row filters",
    };
  }

  const dialect = validatorOptions.dialectFamily ?? "sqlite";
  const forValidation = toDialectPlaceholders(rewritten, dialect);
  const revalidation = validateSql(forValidation, validatorOptions);
  if (!revalidation.valid) {
    return {
      ok: false,
      reason: `Row-filter rewrite failed validation: ${revalidation.reason}`,
    };
  }

  return {
    ok: true,
    sql: revalidation.normalizedSql ?? forValidation,
    params,
  };
}

function inspectSingleSelect(
  sql: string,
  dialect: DialectFamily | undefined,
):
  | { ok: true; tables: DirectTableReference[] }
  | { ok: false; reason: string } {
  let ast: unknown;
  try {
    ast = parser.astify(replaceBindMarkersForParsing(sql), {
      database: parserDatabase(dialect),
    });
  } catch {
    return { ok: false, reason: "SQL could not be parsed into a safe AST" };
  }

  if (Array.isArray(ast)) {
    return { ok: false, reason: "Multiple statements are not allowed" };
  }
  const root = asRecord(ast);
  if (!root || root.type !== "select") {
    return { ok: false, reason: "Only a single SELECT can receive row filters" };
  }
  if (root.with || root._next || root.set_op) {
    return {
      ok: false,
      reason: "Row filters cannot be safely applied to CTE or set-operation queries",
    };
  }
  if (containsNestedSelect(root, root)) {
    return {
      ok: false,
      reason: "Row filters cannot be safely applied to nested subqueries",
    };
  }

  const tables: DirectTableReference[] = [];
  if (!Array.isArray(root.from) || root.from.length === 0) {
    return { ok: false, reason: "Row-filtered queries must reference a table" };
  }
  for (const rawItem of root.from) {
    const item = asRecord(rawItem);
    if (!item || typeof item.table !== "string") {
      return { ok: false, reason: "Derived tables are not allowed with row filters" };
    }
    const table = item.table.toLowerCase();
    const qualifier =
      typeof item.as === "string" && item.as.trim()
        ? item.as.trim()
        : item.table;
    if (!isSafeIdentifier(table) || !isSafeIdentifier(qualifier)) {
      return { ok: false, reason: "Unsafe table or alias in row-filtered query" };
    }
    tables.push({ table, qualifier });
  }
  return { ok: true, tables };
}

function predicateClause(
  columnRef: string,
  predicate: TypedPolicyPredicate,
  params: (string | number)[],
): { ok: true; sql: string } | { ok: false; reason: string } {
  if (predicate.operator === "=") {
    if (predicate.values.length !== 1) {
      return { ok: false, reason: "The = predicate requires exactly one value" };
    }
    params.push(predicate.values[0]!);
    return { ok: true, sql: `${columnRef} = ?` };
  }
  if (predicate.operator === "in" || predicate.operator === "not_in") {
    if (predicate.values.length === 0) {
      return { ok: false, reason: "IN/NOT IN predicates cannot be empty" };
    }
    params.push(...predicate.values);
    const operator = predicate.operator === "in" ? "IN" : "NOT IN";
    return {
      ok: true,
      sql: `${columnRef} ${operator} (${predicate.values.map(() => "?").join(", ")})`,
    };
  }
  return {
    ok: false,
    reason: `Unsupported policy predicate: ${String(predicate.operator)}`,
  };
}

function injectTopLevelWhere(sql: string, filterSql: string): string | null {
  const tokens = scanTopLevelTokens(sql);
  const where = tokens.find((token) => token.word === "WHERE");
  if (where) {
    return `${sql.slice(0, where.end)} (${filterSql}) AND${sql.slice(where.end)}`;
  }

  const boundary = tokens.find((token) =>
    ["GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR"].includes(
      token.word,
    ),
  );
  const at = boundary?.start ?? sql.length;
  const before = sql.slice(0, at).trimEnd();
  const after = sql.slice(at).trimStart();
  return after
    ? `${before} WHERE ${filterSql} ${after}`
    : `${before} WHERE ${filterSql}`;
}

function scanTopLevelTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (char === "'" || char === '"' || char === "`") {
      i = skipQuoted(sql, i, char);
      continue;
    }
    if (char === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (char === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i += 1;
      tokens.push({ word: sql.slice(start, i).toUpperCase(), start, end: i });
      continue;
    }
    i += 1;
  }
  return tokens;
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (sql[i] === "\\" && quote !== "'") i += 2;
    else i += 1;
  }
  return sql.length;
}

function containsNestedSelect(value: unknown, root: AstRecord): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsNestedSelect(item, root));
  }
  const record = asRecord(value);
  if (!record) return false;
  if (record !== root && record.type === "select") return true;
  const nestedAst = asRecord(record.ast);
  if (nestedAst?.type === "select") return true;
  return Object.values(record).some((child) =>
    child === root ? false : containsNestedSelect(child, root),
  );
}

function replaceBindMarkersForParsing(sql: string): string {
  let output = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (char === "'" || char === '"' || char === "`") {
      const end = skipQuoted(sql, i, char);
      output += sql.slice(i, end);
      i = end;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      const nextIndex = end < 0 ? sql.length : end + 1;
      output += sql.slice(i, nextIndex);
      i = nextIndex;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const nextIndex = end < 0 ? sql.length : end + 2;
      output += sql.slice(i, nextIndex);
      i = nextIndex;
      continue;
    }
    if (char === "?") {
      output += "NULL";
      i += 1;
      continue;
    }
    output += char;
    i += 1;
  }
  return output;
}

function parserDatabase(dialect: DialectFamily | undefined): string {
  switch (dialect) {
    case "mysql":
      return "MySQL";
    case "postgresql":
      return "PostgresQL";
    case "tsql":
      return "TransactSQL";
    case "oracle":
    case "db2":
    case "hana":
      return "PostgresQL";
    case "sqlite":
    default:
      return "Sqlite";
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function asRecord(value: unknown): AstRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AstRecord)
    : null;
}
