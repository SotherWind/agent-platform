import { loadEvaluationFixtures } from "./fixtures";
import { calculateMetrics, calculateSavingsConclusion } from "./metrics";
import { createFakeExternalServices } from "./replay";
import type { EvaluationOptions, EvaluationReport, EvaluationResult } from "./types";

export async function runEvaluation(options: EvaluationOptions = {}): Promise<EvaluationReport> {
  const seed = options.seed ?? 20260903;
  const fixtures = await loadEvaluationFixtures(options.fixtureDir);
  const fakeServices = createFakeExternalServices(seed);
  const results: EvaluationResult[] = fixtures.map((fixture) => {
    const observed = fakeServices.replay(
      {
        caseId: fixture.id,
        category: fixture.category,
        seed,
        replayToken: "",
      },
      fixture,
    );
    const passed =
      fixture.expected.knowledgeHit === observed.knowledgeHit &&
      fixture.expected.factuallyCorrect === observed.factuallyCorrect &&
      fixture.expected.toolCallCorrect === observed.toolCallCorrect;

    return {
      caseId: fixture.id,
      category: fixture.category,
      query: fixture.query,
      passed,
      expected: fixture.expected,
      observed,
      knowledgeHit: observed.knowledgeHit,
      factuallyCorrect: observed.factuallyCorrect,
      toolCallCorrect: observed.toolCallCorrect,
      humanInvolved: observed.humanInvolved,
      secondVisit: observed.secondVisit,
      deflected: observed.deflected,
      resolved: !observed.humanInvolved && !observed.secondVisit,
      latencyMs: observed.latencyMs,
      costUsd: observed.costUsd,
      satisfaction: observed.satisfaction,
    };
  });

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
