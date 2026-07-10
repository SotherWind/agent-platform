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

/** 三种不同错误类型：语法错误 → 表不存在 → 列不存在 */
export const MULTI_BAD_SQL = [
  "SELECT FROM users",
  "SELECT * FROM userz",
  "SELECT cityy, COUNT(*) AS cnt FROM users GROUP BY cityy",
] as const;

export function hasLlmConfig(): boolean {
  return Boolean(process.env.MODEL_API_KEY);
}
