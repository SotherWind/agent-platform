import type { ExecutionResult } from "../../src/entities";

/** 镜像 agent.ts createSqlGeneratorNode 的 query 拼接逻辑 */
export function buildSqlGenQuery(
  analysisQuery: string,
  executionResult?: { error?: string | null } | null,
) {
  const { error } = executionResult || {};
  return error ? `${analysisQuery} (fix error: ${error})` : analysisQuery;
}

/** 镜像 agent.ts retryNode + StateSchema ReducedValue reducer */
export function applyRetryIncrement(currentRetryCount: number) {
  return currentRetryCount + 1;
}

/** 镜像 agent.ts chartFormatterNode 各分支 */
export function simulateChartFormatter(
  analysisQuery: string,
  executionResult: ExecutionResult | null,
  suggestChart?: () => { chartType: "bar"; title: string; explanation: string },
) {
  if (!executionResult) return { finalAnswer: "No execution result." };
  if (executionResult.error) {
    return { finalAnswer: `Execution error: ${executionResult.error}` };
  }
  if (executionResult.isEmpty) {
    return {
      finalAnswer: "Query returned no data.",
      chartSpec: { type: "table" as const, title: "Empty Result", dataset: { columns: [], rows: [] } },
    };
  }
  try {
    const chartConfig = suggestChart?.();
    if (!chartConfig) throw new Error("chart config unavailable");
    return { finalAnswer: chartConfig.explanation, chartSpec: { type: chartConfig.chartType, title: chartConfig.title } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      finalAnswer: `Formatting failed: ${message}. Degrading to table format.`,
      chartSpec: { type: "table" as const, title: "Raw Data Fallback", dataset: { columns: [], rows: [] } },
    };
  }
}

/** 从 sqlGenerator 重试 query 中提取触发自愈的错误信息 */
export function extractFixError(query: string): string | null {
  const match = query.match(/\(fix error: (.+)\)$/s);
  return match?.[1] ?? null;
}

/** 打印多次重试的完整轨迹 */
export function logRetryTrail(capturedQueries: string[], failedSqls: string[]) {
  console.log(`      重试轨迹 (${capturedQueries.length} 次 SQL 生成):`);
  for (let i = 0; i < capturedQueries.length; i++) {
    const err = i > 0 ? extractFixError(capturedQueries[i]) : null;
    console.log(`        #${i + 1} LLM query: ${capturedQueries[i].slice(0, 72)}${capturedQueries[i].length > 72 ? "..." : ""}`);
    if (failedSqls[i]) console.log(`           失败 SQL: ${failedSqls[i]}`);
    if (err) console.log(`           携带错误: ${err}`);
  }
}
