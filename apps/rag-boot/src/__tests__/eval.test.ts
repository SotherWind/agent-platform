import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { calculateMetrics, calculateSavingsConclusion } from "../eval/metrics";
import { loadEvaluationFixtures } from "../eval/fixtures";
import { createFakeExternalServices } from "../eval/replay";
import { runEvaluation } from "../eval/runner";
import { DEFAULT_QUALITY_GATE_CONFIG, evaluateQualityGate } from "../eval/quality-gate";

describe("T7.1 评测框架", () => {
  it("能从 fixture 加载评测集并批量回放", async () => {
    const fixtures = await loadEvaluationFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    expect(new Set(fixtures.map((fixture) => fixture.category)).size).toBe(6);
  });

  it("回放使用固定 seed 与 fake 外部服务，结果可复现", async () => {
    const first = await runEvaluation({ seed: 1234 });
    const second = await runEvaluation({ seed: 1234 });
    expect(first).toEqual(second);
  });

  it("每个专家类别有独立评测集文件", async () => {
    const fixtureDir = fileURLToPath(new URL("../eval/fixtures/", import.meta.url));
    const files = await Promise.all(["billing", "integration", "account", "technical", "order", "general"].map((category) => readFile(`${fixtureDir}${category}.jsonl`, "utf8")));
    expect(files.every((file) => file.trim().length > 0)).toBe(true);
  });

  it("输出逐条判定结果与聚合指标", async () => {
    const report = await runEvaluation();
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.metrics.totalCases).toBe(report.results.length);
    expect(report.metrics.resolutionRate).toBeGreaterThanOrEqual(0);
  });

  it("fake 外部服务拒绝错误 seed", () => {
    const fake = createFakeExternalServices(7);
    const fixture = {
      id: "general-test",
      category: "general" as const,
      query: "test",
      expected: { knowledgeHit: true, factuallyCorrect: true, toolCallCorrect: true },
      replay: { knowledgeHit: true, factuallyCorrect: true, toolCallCorrect: true, humanInvolved: false, secondVisit: false, deflected: true, latencyMs: 1, costUsd: 0, satisfaction: 5 },
    };
    expect(() => fake.replay({ caseId: fixture.id, category: fixture.category, seed: 8, replayToken: "" }, fixture)).toThrow("seed mismatch");
  });
});

describe("T7.2 指标计算", () => {
  it("resolutionRate 定义为无人工介入且无二次来访", async () => {
    const report = await runEvaluation();
    const expected = report.results.filter((result) => !result.humanInvolved && !result.secondVisit).length / report.results.length;
    expect(report.metrics.resolutionRate).toBe(expected);
  });

  it("deflectionRate 与 resolutionRate 分开计算，不可互相替代", async () => {
    const report = await runEvaluation();
    expect(report.metrics.deflectionRate).not.toBe(report.metrics.resolutionRate);
    expect(report.metrics.metricNotes.deflectionRate).toContain("不得单独论证收益");
  });

  it("没有人工 baseline 时，代码级拒绝输出 savings 结论", async () => {
    const report = await runEvaluation();
    expect(() => calculateSavingsConclusion(report.metrics)).toThrow("缺少人工 baseline");
    expect(report.savingsConclusion).toBeUndefined();
  });

  it("同时输出质量、延迟、成本和满意度指标", async () => {
    const metrics = (await runEvaluation()).metrics;
    expect(metrics).toMatchObject({ knowledgeHitRate: expect.any(Number), factualAccuracyRate: expect.any(Number), toolCallAccuracyRate: expect.any(Number), escalationRate: expect.any(Number), p95LatencyMs: expect.any(Number), averageCostPerSessionUsd: expect.any(Number), satisfactionAverage: expect.any(Number) });
  });
});

describe("T7.3 质量门禁", () => {
  it("resolutionRate 低于基线阈值时失败", async () => {
    const report = await runEvaluation();
    const result = evaluateQualityGate({ report, securityTestsPassed: true, config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 1 } });
    expect(result.passed).toBe(false);
    expect(result.checks.resolutionBaseline.passed).toBe(false);
  });

  it("安全测试失败即阻断合并", async () => {
    const report = await runEvaluation();
    const result = evaluateQualityGate({ report, securityTestsPassed: false, config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 0 } });
    expect(result.passed).toBe(false);
    expect(result.checks.securityTests.blockOnFailure).toBe(true);
  });

  it("满意度下限门槛写入配置且在报告中显式回显", async () => {
    const report = await runEvaluation();
    const result = evaluateQualityGate({ report, securityTestsPassed: true, config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 0, satisfactionMinimum: 5 } });
    expect(result.checks.satisfactionMinimum.minimum).toBe(5);
    expect(result.checks.satisfactionMinimum.actual).toBe(report.metrics.satisfactionAverage);
  });
});
