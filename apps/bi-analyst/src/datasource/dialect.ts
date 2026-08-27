import type { DialectFamily } from "./types.js";
import { DIALECT_CAPABILITIES } from "./capabilities.js";

/** Text-to-SQL / 编译器用的方言提示 */
export function dialectPromptHints(dialect: DialectFamily): string[] {
  const caps = DIALECT_CAPABILITIES[dialect];
  const quote = caps.identifierQuote;
  const hints = [
    `使用 ${dialect} 方言`,
    `标识符引用字符: ${quote}`,
  ];

  switch (dialect) {
    case "mysql":
      hints.push("分页使用 LIMIT n OFFSET m");
      hints.push("日期函数: DATE_FORMAT, NOW(), CURDATE()");
      hints.push("字符串拼接使用 CONCAT()");
      break;
    case "postgresql":
      hints.push("分页使用 LIMIT n OFFSET m");
      hints.push("日期函数: to_char, NOW(), CURRENT_DATE");
      hints.push("字符串拼接使用 ||");
      break;
    case "sqlite":
      hints.push("分页使用 LIMIT n OFFSET m");
      hints.push("日期函数: strftime, datetime('now')");
      break;
    case "tsql":
      hints.push("分页使用 OFFSET m ROWS FETCH NEXT n ROWS ONLY");
      hints.push("日期函数: FORMAT, GETDATE()");
      break;
    case "oracle":
      hints.push("分页优先使用 FETCH FIRST n ROWS ONLY（12c+）或 ROWNUM");
      hints.push("日期函数: TO_CHAR, SYSDATE");
      hints.push("字符串拼接使用 ||");
      break;
    case "db2":
      hints.push("分页使用 LIMIT n OFFSET m（或 FETCH FIRST）");
      hints.push("日期函数: CURRENT DATE, VARCHAR_FORMAT");
      break;
    case "hana":
      hints.push("分页使用 LIMIT n OFFSET m");
      hints.push("日期函数: CURRENT_DATE, TO_VARCHAR");
      break;
    default:
      break;
  }

  if (caps.supportsWindowFunctions) {
    hints.push("支持窗口函数");
  }

  return hints;
}

/** 将 LIMIT/OFFSET 渲染为方言分页子句 */
export function renderPagination(
  dialect: DialectFamily,
  limit: number,
  offset = 0,
): string {
  const caps = DIALECT_CAPABILITIES[dialect];
  switch (caps.paginationStyle) {
    case "offset-fetch":
      return `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    case "rownum":
      return `FETCH FIRST ${limit} ROWS ONLY`;
    case "limit":
    default:
      return offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }
}

/** 按方言语法规约标识符 */
export function quoteIdentifier(dialect: DialectFamily, name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
  const q = DIALECT_CAPABILITIES[dialect].identifierQuote;
  if (q === "[") return `[${name}]`;
  return `${q}${name}${q}`;
}
