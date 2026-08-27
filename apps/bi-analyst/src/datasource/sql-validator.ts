import SqlParser from "node-sql-parser";
import type { DialectFamily } from "./types.js";
import { renderPagination } from "./dialect.js";

const { Parser } = SqlParser;
const parser = new Parser();

export interface SqlValidatorOptions {
  dialectFamily?: DialectFamily;
  maxRows?: number;
  maxJoins?: number;
  maxCteDepth?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  deniedColumns?: Record<string, string[]>;
  /** 这些表的查询必须带 WHERE（或聚合），否则视为成本过高 */
  requireFilterTables?: string[];
  /** 额外允许的函数名（小写）；默认内置只读函数白名单 */
  allowedFunctions?: string[];
}

export interface SqlValidationResult {
  valid: boolean;
  reason?: string;
  /** 若原 SQL 无 LIMIT，返回包裹后的 SQL */
  normalizedSql?: string;
  failureKind?:
    | "syntax_error"
    | "permission_denied"
    | "cost_rejected"
    | "policy_rejected";
}

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_JOINS = 10;
const DEFAULT_MAX_CTE_DEPTH = 5;

/** 只读聚合 / 标量函数白名单（小写） */
const DEFAULT_ALLOWED_FUNCTIONS = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "coalesce",
  "nullif",
  "ifnull",
  "cast",
  "abs",
  "round",
  "floor",
  "ceil",
  "ceiling",
  "length",
  "lower",
  "upper",
  "trim",
  "ltrim",
  "rtrim",
  "substr",
  "substring",
  "replace",
  "date",
  "datetime",
  "time",
  "strftime",
  "printf",
  "julianday",
  "date_format",
  "to_char",
  "to_varchar",
  "varchar_format",
  "date_trunc",
  "concat",
  "year",
  "quarter",
  "datepart",
  "convert",
  "right",
  "curdate",
  "now",
  "current_date",
  "current_timestamp",
  "group_concat",
  "json_extract",
  "typeof",
]);

const DENIED_FUNCTIONS = new Set([
  "load_file",
  "pg_read_file",
  "pg_write_file",
  "pg_ls_dir",
  "xp_cmdshell",
  "sp_executesql",
  "openrowset",
  "opendatasource",
  "system",
  "readfile",
  "writefile",
  "eval",
  "exec",
  "execute",
  "sleep",
  "benchmark",
]);

const FORBIDDEN_STATEMENT_PATTERNS = [
  /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL|DO|COPY|LOAD|ATTACH|DETACH|PRAGMA\s+(?!table_info|foreign_key_list))/i,
];

const DANGEROUS_PATTERNS = [
  /\bINTO\s+(OUTFILE|DUMPFILE|SOME\s+TABLE)\b/i,
  /\bSELECT\b[\s\S]*?\bINTO\b/i,
  /\bpg_read_file\b/i,
  /\bpg_write_file\b/i,
  /\bload_file\s*\(/i,
  /\breadfile\s*\(/i,
  /\bsystem\s*\(/i,
  /\bxp_cmdshell\b/i,
  /\bsp_executesql\b/i,
  /\bopenrowset\b/i,
  /\bopendatasource\b/i,
  /\bexec\s*\(/i,
  /\bpragma\s+(?!table_info|foreign_key_list)/i,
];

type AstNode = Record<string, unknown> | AstNode[] | null | undefined;

interface WalkContext {
  cteNames: Set<string>;
  tables: Set<string>;
  joins: number;
  columns: Array<{ table: string | null; column: string }>;
  functions: Set<string>;
  cteDepth: number;
  maxCteDepthSeen: number;
  hasWhereInScopes: Map<string, boolean>;
  selectStars: Array<{ tablesInScope: string[] }>;
  aliasToTable: Map<string, string>;
}

function dialectToParserDb(dialect?: DialectFamily): string {
  switch (dialect) {
    case "mysql":
      return "MySQL";
    case "postgresql":
      return "PostgresQL";
    case "tsql":
      return "TransactSQL";
    case "oracle":
      // node-sql-parser 的 PL/SQL 对聚合 SELECT 不稳定；planned 阶段先用 PostgresQL AST 做只读门禁
      return "PostgresQL";
    case "db2":
    case "hana":
      return "PostgresQL";
    case "sqlite":
    default:
      return "Sqlite";
  }
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

function hasMultipleStatements(sql: string): boolean {
  const stripped = stripComments(sql).trim();
  const withoutStrings = stripped.replace(/'(?:''|[^'])*'/g, "''");
  const parts = withoutStrings.split(";").filter((p) => p.trim().length > 0);
  return parts.length > 1;
}

function isReadOnlyQuery(sql: string): boolean {
  const normalized = stripComments(sql).trim();
  return /^(WITH|SELECT)\b/i.test(normalized);
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

function containsDestructiveKeywords(sql: string): boolean {
  const stripped = stripStringLiterals(stripComments(sql));
  return /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|ATTACH|DETACH)\b/i.test(
    stripped,
  );
}

function hasLimitClause(sql: string, dialect: DialectFamily = "sqlite"): boolean {
  const stripped = stripComments(sql);
  if (/\bLIMIT\s+\d+/i.test(stripped)) return true;
  if (dialect === "oracle") {
    return /\bFETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b/i.test(stripped);
  }
  if (dialect === "tsql") {
    return /\bTOP\s*(?:\(\s*)?\d+\s*\)?/i.test(stripped) ||
      /\bOFFSET\s+\d+\s+ROWS?\s+FETCH\s+(?:NEXT|FIRST)\s+\d+\s+ROWS?\s+ONLY\b/i.test(stripped);
  }
  return false;
}

function wrapWithLimit(sql: string, maxRows: number, dialect: DialectFamily = "sqlite"): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (hasLimitClause(trimmed, dialect)) {
    return trimmed;
  }
  if (dialect === "tsql") {
    return `SELECT TOP ${maxRows} * FROM (${trimmed}) AS __limited__`;
  }
  const alias = dialect === "oracle" ? "__limited__" : "AS __limited__";
  return `SELECT * FROM (${trimmed}) ${alias} ${renderPagination(dialect, maxRows, 0)}`;
}

function asRecord(node: unknown): Record<string, unknown> | null {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    return node as Record<string, unknown>;
  }
  return null;
}

function cteNameValue(nameNode: unknown): string | null {
  if (typeof nameNode === "string") return nameNode.toLowerCase();
  const rec = asRecord(nameNode);
  if (!rec) return null;
  if (typeof rec.value === "string") return rec.value.toLowerCase();
  return null;
}

function functionName(expr: Record<string, unknown>): string | null {
  const name = expr.name;
  if (typeof name === "string") return name.toLowerCase();
  const rec = asRecord(name);
  if (!rec) return null;
  if (Array.isArray(rec.name)) {
    const parts = rec.name
      .map((p) => {
        const part = asRecord(p);
        return typeof part?.value === "string" ? part.value : null;
      })
      .filter((v): v is string => Boolean(v));
    return parts.length ? parts.join(".").toLowerCase() : null;
  }
  if (typeof rec.name === "string") return rec.name.toLowerCase();
  return null;
}

function columnName(col: unknown): string | null {
  if (typeof col === "string") return col;
  const rec = asRecord(col);
  if (!rec) return null;
  if (typeof rec.expr === "string") return rec.expr;
  if (typeof rec.value === "string") return rec.value;
  if (typeof rec.column === "string") return rec.column;
  return null;
}

function createWalkContext(): WalkContext {
  return {
    cteNames: new Set(),
    tables: new Set(),
    joins: 0,
    columns: [],
    functions: new Set(),
    cteDepth: 0,
    maxCteDepthSeen: 0,
    hasWhereInScopes: new Map(),
    selectStars: [],
    aliasToTable: new Map(),
  };
}

/** 递归遍历 SELECT AST（含 UNION 链），收集表/列/函数/JOIN/CTE 深度 */
function walkSelect(node: unknown, ctx: WalkContext): string | null {
  let current: unknown = node;
  while (current) {
    const currentStmt = asRecord(current);
    if (!currentStmt) return "无法解析的 SQL AST";

    if (currentStmt.type && currentStmt.type !== "select") {
      return `禁止非 SELECT 语句: ${String(currentStmt.type)}`;
    }

    const err = walkSingleSelect(currentStmt, ctx);
    if (err) return err;

    current = currentStmt._next;
  }
  return null;
}

function walkSingleSelect(
  stmt: Record<string, unknown>,
  ctx: WalkContext,
): string | null {
  // CTE
  if (Array.isArray(stmt.with)) {
    const nextDepth = ctx.cteDepth + 1;
    ctx.maxCteDepthSeen = Math.max(ctx.maxCteDepthSeen, nextDepth);
    for (const cte of stmt.with) {
      const cteRec = asRecord(cte);
      if (!cteRec) continue;
      const name = cteNameValue(cteRec.name);
      if (name) ctx.cteNames.add(name);

      const cteStmt = asRecord(cteRec.stmt);
      const nestedAst = cteStmt?.ast ?? cteRec.stmt;
      const nestedCtx: WalkContext = {
        ...ctx,
        cteDepth: nextDepth,
        aliasToTable: new Map(ctx.aliasToTable),
      };
      const err = walkSelect(nestedAst, nestedCtx);
      if (err) return err;
      // merge collected facts
      for (const t of nestedCtx.tables) ctx.tables.add(t);
      ctx.joins += nestedCtx.joins;
      ctx.columns.push(...nestedCtx.columns);
      for (const f of nestedCtx.functions) ctx.functions.add(f);
      ctx.maxCteDepthSeen = Math.max(
        ctx.maxCteDepthSeen,
        nestedCtx.maxCteDepthSeen,
      );
      for (const [k, v] of nestedCtx.hasWhereInScopes) {
        ctx.hasWhereInScopes.set(k, v);
      }
      ctx.selectStars.push(...nestedCtx.selectStars);
      for (const n of nestedCtx.cteNames) ctx.cteNames.add(n);
    }
  }

  // FROM / JOIN
  const scopeAliases = new Map<string, string>(ctx.aliasToTable);
  const tablesInScope: string[] = [];
  if (Array.isArray(stmt.from)) {
    for (const fromItem of stmt.from) {
      const item = asRecord(fromItem);
      if (!item) continue;

      if (item.expr) {
        // 子查询 FROM (SELECT ...) AS alias
        const exprRec = asRecord(item.expr);
        const nested = exprRec?.ast ?? item.expr;
        const subErr = walkSelect(nested, {
          ...ctx,
          aliasToTable: new Map(scopeAliases),
        });
        if (subErr) return subErr;
        continue;
      }

      if (typeof item.table === "string") {
        const table = item.table.toLowerCase();
        const alias =
          typeof item.as === "string" ? item.as.toLowerCase() : table;
        if (!ctx.cteNames.has(table)) {
          ctx.tables.add(table);
          tablesInScope.push(table);
        }
        scopeAliases.set(alias, ctx.cteNames.has(table) ? table : table);
        ctx.aliasToTable.set(alias, table);
      }

      if (typeof item.join === "string") {
        ctx.joins += 1;
      }

      if (item.on) {
        collectExpr(item.on, ctx, scopeAliases);
      }
    }
  }

  // SELECT columns
  if (stmt.columns === "*") {
    ctx.selectStars.push({ tablesInScope: [...tablesInScope] });
  } else if (Array.isArray(stmt.columns)) {
    for (const col of stmt.columns) {
      const colRec = asRecord(col);
      if (!colRec) continue;
      collectExpr(colRec.expr ?? colRec, ctx, scopeAliases, tablesInScope);
    }
  }

  if (stmt.where) {
    for (const table of tablesInScope) {
      ctx.hasWhereInScopes.set(table, true);
    }
    collectExpr(stmt.where, ctx, scopeAliases, tablesInScope);
  } else {
    for (const table of tablesInScope) {
      if (!ctx.hasWhereInScopes.has(table)) {
        ctx.hasWhereInScopes.set(table, false);
      }
    }
  }

  if (stmt.having) collectExpr(stmt.having, ctx, scopeAliases, tablesInScope);
  if (Array.isArray(stmt.groupby)) {
    for (const g of stmt.groupby) collectExpr(g, ctx, scopeAliases, tablesInScope);
  }
  if (Array.isArray(stmt.orderby)) {
    for (const o of stmt.orderby) {
      const ord = asRecord(o);
      collectExpr(ord?.expr ?? o, ctx, scopeAliases, tablesInScope);
    }
  }

  return null;
}

function collectExpr(
  node: unknown,
  ctx: WalkContext,
  aliases: Map<string, string>,
  tablesInScope: string[] = [],
): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectExpr(item, ctx, aliases, tablesInScope);
    return;
  }
  const rec = asRecord(node);
  if (!rec) return;

  if (rec.type === "column_ref") {
    const col = columnName(rec.column) ?? columnName(rec);
    if (!col) return;
    if (col === "*") {
      ctx.selectStars.push({ tablesInScope: [...tablesInScope] });
      return;
    }
    const tableAlias =
      typeof rec.table === "string" ? rec.table.toLowerCase() : null;
    const resolved = tableAlias
      ? (aliases.get(tableAlias) ?? tableAlias)
      : tablesInScope.length === 1
        ? tablesInScope[0]!
        : null;
    if (resolved && ctx.cteNames.has(resolved)) {
      // CTE 列引用，跳过物理表权限检查
      return;
    }
    ctx.columns.push({ table: resolved, column: col.toLowerCase() });
    return;
  }

  if (rec.type === "function" || rec.type === "aggr_func") {
    const fname = functionName(rec) ?? (typeof rec.name === "string" ? rec.name.toLowerCase() : null);
    if (fname) ctx.functions.add(fname.split(".").pop()!);
    if (rec.args) collectExpr(rec.args, ctx, aliases, tablesInScope);
    if (rec.over) collectExpr(rec.over, ctx, aliases, tablesInScope);
    return;
  }

  if (rec.type === "select") {
    walkSelect(rec, {
      ...ctx,
      aliasToTable: new Map(aliases),
    });
    return;
  }

  // node-sql-parser 子查询常包装为 { tableList, columnList, ast }
  const nestedAst = asRecord(rec.ast);
  if (nestedAst?.type === "select") {
    walkSelect(nestedAst, {
      ...ctx,
      aliasToTable: new Map(aliases),
    });
    return;
  }

  if (rec.type === "expr_list" && Array.isArray(rec.value)) {
    collectExpr(rec.value, ctx, aliases, tablesInScope);
    return;
  }

  // binary / unary / case / cast 等：遍历常见子节点
  for (const key of [
    "left",
    "right",
    "expr",
    "astype",
    "args",
    "value",
    "parentheses",
    "cond",
    "result",
    "else",
  ]) {
    if (key in rec) collectExpr(rec[key], ctx, aliases, tablesInScope);
  }
  if (Array.isArray(rec.args)) collectExpr(rec.args, ctx, aliases, tablesInScope);
  if (Array.isArray(rec.columns)) collectExpr(rec.columns, ctx, aliases, tablesInScope);
}

function reject(reason: string, failureKind: SqlValidationResult["failureKind"]): SqlValidationResult {
  return { valid: false, reason, failureKind };
}

/**
 * 方言 AST 校验：语法/对象/函数/作用域/成本。
 * 解析失败时 fail-closed（拒绝），防止绕过。
 */
export function validateSql(
  sql: string,
  options: SqlValidatorOptions = {},
): SqlValidationResult {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxJoins = options.maxJoins ?? DEFAULT_MAX_JOINS;
  const maxCteDepth = options.maxCteDepth ?? DEFAULT_MAX_CTE_DEPTH;

  if (!sql || sql.trim().length === 0) {
    return reject("SQL 不能为空", "syntax_error");
  }

  if (hasMultipleStatements(sql)) {
    return reject("禁止多语句执行", "policy_rejected");
  }

  for (const pattern of FORBIDDEN_STATEMENT_PATTERNS) {
    if (pattern.test(stripComments(sql))) {
      return reject("禁止非 SELECT 或副作用语句", "policy_rejected");
    }
  }

  if (!isReadOnlyQuery(sql)) {
    return reject("仅允许 SELECT / WITH 只读查询", "policy_rejected");
  }

  if (containsDestructiveKeywords(sql)) {
    return reject("禁止非 SELECT 或副作用语句", "policy_rejected");
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sql)) {
      return reject("检测到危险函数或副作用 SELECT", "policy_rejected");
    }
  }

  let ast: unknown;
  try {
    // 参数占位符 ? 替换为 NULL 以便 AST 解析（不改变最终执行 SQL）
    const forParse = sql
      .trim()
      .replace(/;\s*$/, "")
      .replace(/\?/g, "NULL");
    ast = parser.astify(forParse, {
      database: dialectToParserDb(options.dialectFamily),
    });
  } catch {
    return reject("SQL 无法解析为安全 AST，已拒绝", "syntax_error");
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return reject("禁止多语句执行", "policy_rejected");
  }

  const root = asRecord(statements[0]);
  if (!root || root.type !== "select") {
    return reject(
      `禁止非 SELECT 语句: ${String(root?.type ?? "unknown")}`,
      "policy_rejected",
    );
  }

  const ctx = createWalkContext();
  const walkErr = walkSelect(root, ctx);
  if (walkErr) {
    return reject(walkErr, "policy_rejected");
  }

  if (ctx.maxCteDepthSeen > maxCteDepth) {
    return reject(
      `CTE 嵌套深度超过限制 (${maxCteDepth})`,
      "cost_rejected",
    );
  }

  if (ctx.joins > maxJoins) {
    return reject(`JOIN 数量超过限制 (${maxJoins})`, "cost_rejected");
  }

  const allowedFns = new Set(DEFAULT_ALLOWED_FUNCTIONS);
  for (const fn of options.allowedFunctions ?? []) {
    allowedFns.add(fn.toLowerCase());
  }
  for (const fn of ctx.functions) {
    if (DENIED_FUNCTIONS.has(fn)) {
      return reject(`禁止危险函数: ${fn}`, "policy_rejected");
    }
    if (!allowedFns.has(fn)) {
      return reject(`未授权函数: ${fn}`, "policy_rejected");
    }
  }

  if (options.allowedTables?.length) {
    const allowed = new Set(options.allowedTables.map((t) => t.toLowerCase()));
    for (const table of ctx.tables) {
      if (!allowed.has(table)) {
        return reject(`无权访问表: ${table}`, "permission_denied");
      }
    }
  }

  if (options.allowedColumns && Object.keys(options.allowedColumns).length > 0) {
    if (ctx.selectStars.length > 0) {
      return reject(
        "列白名单模式下禁止 SELECT *",
        "permission_denied",
      );
    }
    for (const col of ctx.columns) {
      if (!col.table) {
        // 多表且无法消解时保守拒绝敏感列名冲突；无法证明归属则拒绝
        const possible = Object.entries(options.allowedColumns).filter(
          ([table]) => ctx.tables.has(table.toLowerCase()),
        );
        const permittedSomewhere = possible.some(([, cols]) =>
          cols.map((c) => c.toLowerCase()).includes(col.column),
        );
        if (!permittedSomewhere) {
          return reject(`无权访问列: ${col.column}`, "permission_denied");
        }
        continue;
      }
      const allowList = options.allowedColumns[col.table];
      if (!allowList) continue;
      if (!allowList.map((c) => c.toLowerCase()).includes(col.column)) {
        return reject(
          `无权访问列: ${col.table}.${col.column}`,
          "permission_denied",
        );
      }
    }
  }

  if (options.deniedColumns && Object.keys(options.deniedColumns).length > 0) {
    if (ctx.selectStars.length > 0) {
      return reject("SELECT * is not allowed when denied columns are configured", "permission_denied");
    }
    const denied = new Map(
      Object.entries(options.deniedColumns).map(([table, columns]) => [
        table.toLowerCase(),
        new Set(columns.map((column) => column.toLowerCase())),
      ]),
    );
    for (const col of ctx.columns) {
      if (col.table && denied.get(col.table)?.has(col.column)) {
        return reject(`Denied column: ${col.table}.${col.column}`, "permission_denied");
      }
      if (!col.table && [...denied.values()].some((columns) => columns.has(col.column))) {
        return reject(`Denied column: ${col.column}`, "permission_denied");
      }
    }
  }

  if (options.requireFilterTables?.length) {
    for (const table of options.requireFilterTables.map((t) => t.toLowerCase())) {
      if (!ctx.tables.has(table)) continue;
      if (ctx.hasWhereInScopes.get(table) !== true) {
        return reject(
          `表 ${table} 缺少过滤条件，成本过高`,
          "cost_rejected",
        );
      }
    }
  }

  const normalizedSql = wrapWithLimit(sql, maxRows, options.dialectFamily ?? "sqlite");
  return { valid: true, normalizedSql };
}

export { DEFAULT_MAX_ROWS, DEFAULT_MAX_JOINS, DEFAULT_MAX_CTE_DEPTH };
