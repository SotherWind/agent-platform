import type { ExecutionResult } from "../../src/entities";

export const sampleRows: ExecutionResult = {
  columns: ["city", "total_amount"],
  rows: [
    { city: "北京", total_amount: 2388.98 },
    { city: "上海", total_amount: 450.0 },
    { city: "广州", total_amount: 450.0 },
  ],
  isEmpty: false,
  stats: { durationMs: 1, rowCount: 3 },
};

/** 三种可安全自愈的坏 SQL：语法错误 → 列不存在 → 另一种列不存在 */
export const MULTI_BAD_SQL = [
  "SELECT FROM users",
  "SELECT cityy, COUNT(*) AS cnt FROM users GROUP BY cityy",
  "SELECT * FROM users WHERE missing_city = '火星'",
] as const;

export function hasLlmConfig(): boolean {
  return Boolean(process.env.MODEL_API_KEY);
}

/** Integration-local adapter: exercise the full graph without network I/O. */
export function deterministicIntegrationSql(query: string): string {
  if (/火星/.test(query)) {
    return "SELECT * FROM users WHERE city = '火星'";
  }
  if (/月份|按月|趋势/.test(query)) {
    return "SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS order_count FROM orders GROUP BY month ORDER BY month";
  }
  if (/状态/.test(query)) {
    return "SELECT status, COUNT(*) AS order_count FROM orders GROUP BY status";
  }
  if (/城市/.test(query) && /用户/.test(query)) {
    return "SELECT users.city, COUNT(DISTINCT users.id) AS user_count, SUM(orders.amount) AS total_amount FROM users JOIN orders ON orders.user_id = users.id GROUP BY users.city";
  }
  if (/北京/.test(query) && /(总额|金额)/.test(query)) {
    return "SELECT users.name, SUM(orders.amount) AS total FROM users JOIN orders ON orders.user_id = users.id WHERE users.city = '北京' GROUP BY users.name";
  }
  return "SELECT * FROM orders LIMIT 10";
}
