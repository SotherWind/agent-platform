import type { DataFreshnessMeta } from "../metadata/freshness.js";

/** 将新鲜度状态与警告追加到业务答语 */
export function appendFreshnessWarnings(
  answer: string,
  freshness: DataFreshnessMeta | null | undefined,
): string {
  if (!freshness) return answer;
  if (freshness.status === "fresh" && freshness.warnings.length === 0) {
    return answer;
  }
  const lines = [
    answer,
    "",
    `（数据新鲜度：${freshness.status}，截至 ${freshness.dataAsOf}，时区 ${freshness.timezone}）`,
  ];
  if (freshness.warnings.length > 0) {
    lines.push(`注意：${freshness.warnings.join("；")}`);
  }
  return lines.join("\n");
}
