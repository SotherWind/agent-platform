import { loadEvaluationFixtures } from "./fixtures";
import { calculateMetrics, calculateSavingsConclusion } from "./metrics";
import { runFixtureThroughGraph } from "./replay";
import type { EvaluationOptions, EvaluationReport, EvaluationResult } from "./types";

/**
 * 逐条 fixture 真跑图（串行：fake 状态相互隔离，报告顺序稳定可复现），
 * 拿图的真实行为与人工标注的 expected 比对。
 */
export async function runEvaluation(options: EvaluationOptions = {}): Promise<EvaluationReport> {
  const seed = options.seed ?? 20260903;
  const fixtures = await loadEvaluationFixtures(options.fixtureDir);
  const results: EvaluationResult[] = [];

  for (const fixture of fixtures) {
    const { observation } = await runFixtureThroughGraph(fixture, { seed });
    const passed =
      fixture.expected.knowledgeHit === observation.knowledgeHit &&
      fixture.expected.factuallyCorrect === observation.factuallyCorrect &&
      fixture.expected.toolCallCorrect === observation.toolCallCorrect;

    results.push({
      caseId: fixture.id,
      category: fixture.category,
      query: fixture.query,
      passed,
      expected: fixture.expected,
      observed: observation,
      knowledgeHit: observation.knowledgeHit,
      factuallyCorrect: observation.factuallyCorrect,
      toolCallCorrect: observation.toolCallCorrect,
      humanInvolved: observation.humanInvolved,
      secondVisit: observation.secondVisit,
      deflected: observation.deflected,
      resolved: !observation.humanInvolved && !observation.secondVisit,
      latencyMs: observation.latencyMs,
      costUsd: observation.costUsd,
      satisfaction: observation.satisfaction,
    });
  }

  const report: EvaluationReport = {
    seed,
    results,
    metrics: calculateMetrics(results),
  };
  if (options.humanBaseline) {
    report.savingsConclusion = calculateSavingsConclusion(report.metrics, options.humanBaseline);
  }
  return report;
}

export function formatEvaluationReport(report: EvaluationReport): string {
  return JSON.stringify(report, null, 2);
}
