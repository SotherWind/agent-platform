import type { DialectFamily } from "./types.js";
import { validateSql, type SqlValidatorOptions } from "./sql-validator.js";
import { applyRowFilters } from "../policy/row-filter-rewrite.js";
import type { TypedPolicyPredicate } from "../policy/access-policy.js";
import { toDialectPlaceholders } from "./placeholders.js";

export { toDialectPlaceholders } from "./placeholders.js";

export interface PrepareSqlInput {
  sql: string;
  params?: (string | number)[];
  dialectFamily: DialectFamily;
  maxRows?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  deniedColumns?: Record<string, string[]>;
  requireFilterTables?: string[];
  maxJoins?: number;
  maxCteDepth?: number;
  rowFilters?: TypedPolicyPredicate[];
}

export interface PrepareSqlResult {
  ok: boolean;
  sql?: string;
  params?: (string | number)[];
  failureKind?:
    | "syntax_error"
    | "permission_denied"
    | "cost_rejected"
    | "policy_rejected";
  reason?: string;
}

/**
 * 校验 + 可选 rowFilters 改写，产出可执行 SQL 与绑定参数。
 * MySQL/SQLite 用 `?`；PostgreSQL → `$n`；Oracle → `:n`；T-SQL → `@pN`。
 */
export function prepareExecutableSql(
  input: PrepareSqlInput,
): PrepareSqlResult {
  const validatorOpts: SqlValidatorOptions = {
    dialectFamily: input.dialectFamily,
    maxRows: input.maxRows,
    allowedTables: input.allowedTables,
    allowedColumns: input.allowedColumns,
    deniedColumns: input.deniedColumns,
    requireFilterTables: input.requireFilterTables,
    maxJoins: input.maxJoins,
    maxCteDepth: input.maxCteDepth,
  };

  let sql: string;
  let filterParams: (string | number)[] = [];

  if (input.rowFilters?.length) {
    const rewrite = applyRowFilters(
      input.sql,
      input.rowFilters,
      validatorOpts,
    );
    if (!rewrite.ok || !rewrite.sql) {
      return {
        ok: false,
        failureKind: "policy_rejected",
        reason: rewrite.reason ?? "policy_rejected",
      };
    }
    sql = rewrite.sql;
    filterParams = rewrite.params ?? [];
  } else {
    const validation = validateSql(input.sql, validatorOpts);
    if (!validation.valid) {
      return {
        ok: false,
        failureKind: validation.failureKind ?? "policy_rejected",
        reason: validation.reason ?? "validation_failed",
      };
    }
    sql = validation.normalizedSql!;
  }

  sql = toDialectPlaceholders(sql, input.dialectFamily);
  const params = [...filterParams, ...(input.params ?? [])];
  return { ok: true, sql, params };
}
