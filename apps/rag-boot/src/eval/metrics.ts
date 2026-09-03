import type { EvaluationMetrics, EvaluationResult, HumanBaseline, SavingsConclusion } from "./types";

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

export function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function calculateMetrics(results: EvaluationResult[]): EvaluationMetrics {
  const rated = results.filter((result) => result.satisfaction !== null);
  const resolved = results.filter((result) => result.resolved);
  const deflected = results.filter((result) => result.deflected);

  return {
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    passRate: rate(results.filter((result) => result.passed).length, results.length),
    knowledgeHitRate: rate(results.filter((result) => result.knowledgeHit).length, results.length),
    factualAccuracyRate: rate(results.filter((result) => result.factuallyCorrect).length, results.length),
    toolCallAccuracyRate: rate(results.filter((result) => result.toolCallCorrect).length, results.length),
    resolutionRate: rate(resolved.length, results.length),
    deflectionRate: rate(deflected.length, results.length),
    escalationRate: rate(results.filter((result) => result.humanInvolved).length, results.length),
    p95LatencyMs: percentile95(results.map((result) => result.latencyMs)),
    averageCostPerSessionUsd: rate(results.reduce((sum, result) => sum + result.costUsd, 0), results.length),
    satisfactionAverage: rated.length === 0 ? null : rate(rated.reduce((sum, result) => sum + (result.satisfaction ?? 0), 0), rated.length),
    ratedCaseCount: rated.length,
    metricNotes: {
      resolutionRate: "无人工介入且无二次来访；它是质量指标。",
      deflectionRate: "路由指标，不得单独论证收益；它与 resolutionRate 独立计算。",
    },
  };
}

export function calculateSavingsConclusion(
  metrics: EvaluationMetrics,
  humanBaseline?: HumanBaseline,
): SavingsConclusion {
  if (!humanBaseline) {
    throw new Error("拒绝输出 savings 结论：缺少人工 baseline");
  }
  return {
    label: humanBaseline.label ?? "相对人工 baseline 的 resolution 差值",
    resolutionRate: metrics.resolutionRate,
    humanBaselineResolutionRate: humanBaseline.resolutionRate,
    delta: metrics.resolutionRate - humanBaseline.resolutionRate,
  };
}
