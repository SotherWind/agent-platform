import type { DialectFamily } from "./types.js";

/**
 * 将统一 `?` 占位符转为各方言绑定风格：
 * - postgresql → `$1..$n`
 * - oracle → `:1..:n`（oracledb 位置绑定）
 * - tsql → `@p1..@pn`（tedious 命名参数约定）
 * - 其他（mysql/sqlite/…）保持 `?`
 */
export function toDialectPlaceholders(
  sql: string,
  dialect: DialectFamily,
): string {
  if (dialect === "postgresql") {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }
  if (dialect === "oracle") {
    let index = 0;
    return sql.replace(/\?/g, () => `:${++index}`);
  }
  if (dialect === "tsql") {
    let index = 0;
    return sql.replace(/\?/g, () => `@p${++index}`);
  }
  return sql;
}
