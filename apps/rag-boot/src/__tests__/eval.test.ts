/**
 * T7.1 评测框架 / T7.2 指标计算 / T7.3 质量门禁
 *
 * P7 已改为真跑图：fixture.script 决定 fake LLM 与 fake 向量库，observed 全部
 * 从图输出计算。因此这里的测试有一个新增的核心断言——标注与图行为不一致时
 * 判定必须失败（此前观测就是 fixture 手写值，标注错了也不可能红）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateSavingsConclusion } from "../eval/metrics";
import { loadEvaluationFixtures } from "../eval/fixtures";
import { replayTokenFor } from "../eval/replay";
import { runEvaluation } from "../eval/runner";
import { DEFAULT_QUALITY_GATE_CONFIG, evaluateQualityGate } from "../eval/quality-gate";
import { SPECIALIST_CATEGORIES, EvaluationFixtureSchema, type EvaluationReport } from "../eval/types";

// 每条 fixture 都要 buildGraph 真跑一遍图，单轮全量约数秒；
// T7.2/T7.3 的用例共享同一份报告，避免每个 it 都重跑。
let cachedReport: EvaluationReport | undefined;
const evalOnce = async () => (cachedReport ??= await runEvaluation());

describe("T7.1 评测框架", () => {
  it("能从 fixture 加载评测集并批量回放", async () => {
    const fixtures = await loadEvaluationFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    expect(new Set(fixtures.map((fixture) => fixture.category)).size).toBe(6);
    // 每条 fixture 都带 fake LLM 剧本——回放的外部服务是 fake 的，图是真的
    expect(fixtures.every((fixture) => typeof fixture.script.generate === "string")).toBe(true);
  });

  it("回放使用固定 seed 与 fake 外部服务，结果可复现", async () => {
    const first = await runEvaluation({ seed: 1234 });
    const second = await runEvaluation({ seed: 1234 });
    // latencyMs 是实测值，是唯一的非确定源；其余字段必须逐条完全一致
    const strip = (report: EvaluationReport) =>
      report.results.map(({ observed, latencyMs, ...rest }) => ({
        ...rest,
        latencyMs: 0,
        observed: { ...observed, latencyMs: 0 },
      }));
    expect(strip(first)).toEqual(strip(second));
  });

  it("每个专家类别有独立评测集文件", async () => {
    const fixtureDir = fileURLToPath(new URL("../eval/fixtures/", import.meta.url));
    const files = await Promise.all(["billing", "integration", "account", "technical", "order", "general"].map((category) => readFile(`${fixtureDir}${category}.jsonl`, "utf8")));
    expect(files.every((file) => file.trim().length > 0)).toBe(true);
  });

  it("输出逐条判定结果与聚合指标", async () => {
    const report = await evalOnce();
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.metrics.totalCases).toBe(report.results.length);
    expect(report.metrics.resolutionRate).toBeGreaterThanOrEqual(0);
    // replayToken 与 seed 绑定，跨进程回放可定位同一次运行
    expect(
      report.results.every((r) => r.observed.replayToken === replayTokenFor(report.seed, r.caseId)),
    ).toBe(true);
  });

  it("观测值来自图的真实输出，而不是 fixture 手写字段", async () => {
    const report = await evalOnce();
    // fixture 里没有 latencyMs / costUsd / replayToken 字段——这些是跑图算出来的
    expect(report.results.every((r) => r.observed.latencyMs >= 0)).toBe(true);
    expect(report.results.every((r) => r.observed.costUsd > 0)).toBe(true);
    // knowledgeHit 与图的 citations 对应：升级路径（不走检索）全为 false
    for (const r of report.results) {
      if (r.humanInvolved && r.caseId.endsWith("-002") && r.caseId !== "general-002") {
        expect(r.knowledgeHit).toBe(false);
      }
    }
  });

  it("标注与图行为不一致时判定失败（回归能被探测到）", async () => {    // 这是 P7 修复的核心价值：此前 observed 就是 fixture 手写值，标注写错也永远绿。
    // 现在把 billing-001 的 expected.knowledgeHit 改成与图真实行为相反的值，判定必须红。
    const dir = mkdtempSync(join(tmpdir(), "rag-boot-eval-"));
    try {
      const srcDir = fileURLToPath(new URL("../eval/fixtures/", import.meta.url));
      for (const category of SPECIALIST_CATEGORIES) {
        let content = await readFile(join(srcDir, `${category}.jsonl`), "utf8");
        if (category === "billing") {
          content = content.replace(
            '"expected":{"knowledgeHit":true',
            '"expected":{"knowledgeHit":false',
          );
        }
        await writeFile(join(dir, `${category}.jsonl`), content);
      }

      const report = await runEvaluation({ fixtureDir: dir });
      const billing = report.results.find((r) => r.caseId === "billing-001");
      expect(billing?.passed).toBe(false);
      expect(report.metrics.passRate).toBeLessThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T7.4 置信度闸门的端到端验收", () => {
  // 这一组补的是一个真实缺口：早先 replay 给所有 chunk 恒定 0.9 分，
  // 于是"单条强命中"恒成立，置信度闸门在评测里从来没触发过——
  // 也就是说闸门此前不在任何端到端验收范围内。
  it("fixture 可指定 chunk 分数，且长度必须与召回一一对应", async () => {
    const fixtures = await loadEvaluationFixtures();
    const flock = fixtures.find((fixture) => fixture.id === "general-003");
    expect(flock?.script.chunkScores).toEqual([0.36, 0.32, 0.31, 0.31, 0.3]);

    // 长度不匹配必须报错，不能让分数和 chunk 错位
    expect(() =>
      EvaluationFixtureSchema.parse({
        id: "bad",
        category: "general",
        query: "q",
        script: {
          retrievedChunks: ["a", "b"],
          chunkScores: [0.9],
          generate: "x",
          review: { passed: true },
        },
        expected: { knowledgeHit: true, factuallyCorrect: true, toolCallCorrect: true },
      }),
    ).toThrow(/一一对应/);
  });

  it("群像式幻觉场景被闸门拦下：编造的具体承诺不进用户话术", async () => {
    const report = await evalOnce();
    const flock = report.results.find((result) => result.caseId === "general-003");
    expect(flock).toBeDefined();
    // 图真的判了低置信（不是 fixture 手写的值）
    expect(flock?.lowConfidence).toBe(true);
    expect(flock?.observed.flockHallucination).toBe(true);
    // 绝对口径：5 条里只有 1 条过 floor 线
    expect(flock?.observed.supportCount).toBe(1);
    // 这条的 generate 编了一个引用里没有的 99.99% —— 被输出侧 grounding 拦下，
    // 走转人工；用户看到的是安全话术而不是那段编造（草稿只进交接包）。
    expect(flock?.humanInvolved).toBe(true);
    expect(flock?.factuallyCorrect).toBe(true);
    expect(flock?.passed).toBe(true);
  });

  it("群像式幻觉 + 模型不编造时：低置信话术真的到了用户话术里", async () => {
    const report = await evalOnce();
    const flock = report.results.find((result) => result.caseId === "general-004");
    expect(flock?.lowConfidence).toBe(true);
    expect(flock?.observed.flockHallucination).toBe(true);
    // 没有编造具体数字 → 输出侧不拦 → 答案带不确定表述正常发出
    expect(flock?.humanInvolved).toBe(false);
    expect(flock?.factuallyCorrect).toBe(true);
    expect(flock?.passed).toBe(true);
  });

  it("高置信路径不被误伤：强命中标注 lowConfidence=false 且通过", async () => {
    const report = await evalOnce();
    const strong = report.results.find((result) => result.caseId === "general-001");
    expect(strong?.lowConfidence).toBe(false);
    expect(strong?.passed).toBe(true);
    // 基线：当前 fixture 集应当全部通过（否则上面的"不一致探测"用例会因错误原因变绿）
    expect(report.metrics.passRate).toBe(1);
  });

  it("群像触发率与低置信率有独立统计口径", async () => {
    const metrics = (await evalOnce()).metrics;
    // general-003（编造承诺）与 general-004（不编造）都是群像场景
    expect(metrics.flockHallucinationCount).toBeGreaterThanOrEqual(2);
    expect(metrics.lowConfidenceRate).toBeGreaterThan(0);
    // 低置信是检索侧诊断指标，不等于转人工率
    expect(metrics.lowConfidenceRate).not.toBe(metrics.escalationRate);
    expect(metrics.metricNotes.flockHallucinationCount).toContain("群像式幻觉");
    expect(metrics.metricNotes.lowConfidenceRate).toContain("不等于转人工率");
  });
});

describe("T7.2 指标计算", () => {  it("resolutionRate 定义为无人工介入且无二次来访", async () => {
    const report = await evalOnce();
    const expected = report.results.filter((result) => !result.humanInvolved && !result.secondVisit).length / report.results.length;
    expect(report.metrics.resolutionRate).toBe(expected);
  });

  it("deflectionRate 与 resolutionRate 分开计算，不可互相替代", async () => {
    const report = await evalOnce();
    expect(report.metrics.deflectionRate).not.toBe(report.metrics.resolutionRate);
    expect(report.metrics.metricNotes.deflectionRate).toContain("不得单独论证收益");
  });

  it("没有人工 baseline 时，代码级拒绝输出 savings 结论", async () => {
    const report = await evalOnce();
    expect(() => calculateSavingsConclusion(report.metrics)).toThrow("缺少人工 baseline");
    expect(report.savingsConclusion).toBeUndefined();
  });

  it("同时输出质量、延迟、成本和满意度指标", async () => {
    const metrics = (await evalOnce()).metrics;
    expect(metrics).toMatchObject({
      knowledgeHitRate: expect.any(Number),
      factualAccuracyRate: expect.any(Number),
      toolCallAccuracyRate: expect.any(Number),
      escalationRate: expect.any(Number),
      p95LatencyMs: expect.any(Number),
      averageCostPerSessionUsd: expect.any(Number),
    });
    // 满意度来自真实工单评价回流（T5.4），单轮回放拿不到 → null 而非编造，
    // 字段存在且 ratedCaseCount 如实为 0
    expect(metrics.satisfactionAverage).toBeNull();
    expect(metrics.ratedCaseCount).toBe(0);
  });
});

describe("T7.3 质量门禁", () => {
  it("resolutionRate 低于基线阈值时失败", async () => {
    const report = await evalOnce();
    const result = evaluateQualityGate({ report, securityTestsPassed: true, config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 1 } });
    expect(result.passed).toBe(false);
    expect(result.checks.resolutionBaseline.passed).toBe(false);
  });

  it("安全测试失败即阻断合并", async () => {
    const report = await evalOnce();
    const result = evaluateQualityGate({ report, securityTestsPassed: false, config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 0 } });
    expect(result.passed).toBe(false);
    expect(result.checks.securityTests.blockOnFailure).toBe(true);
  });

  it("满意度下限门槛写入配置且在报告中显式回显", async () => {
    const report = await evalOnce();
    const result = evaluateQualityGate({ report, securityTestsPassed: true, config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 0, satisfactionMinimum: 5 } });
    expect(result.checks.satisfactionMinimum.minimum).toBe(5);
    expect(result.checks.satisfactionMinimum.actual).toBe(report.metrics.satisfactionAverage);
  });

  it("满意度无数据不阻断但回显 noData，有数据低于下限必阻断", async () => {
    const report = await evalOnce();
    // 当前 fixture 无评分数据：noData=true，不阻断（null 是「没有数据」而非「不达标」）
    const noData = evaluateQualityGate({
      report,
      securityTestsPassed: true,
      config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 0 },
    });
    expect(noData.checks.satisfactionMinimum.noData).toBe(true);
    expect(noData.checks.satisfactionMinimum.passed).toBe(true);

    // 有评分数据且低于下限：必须阻断
    const ratedReport: EvaluationReport = {
      ...report,
      metrics: { ...report.metrics, satisfactionAverage: 2, ratedCaseCount: 3 },
    };
    const rated = evaluateQualityGate({
      report: ratedReport,
      securityTestsPassed: true,
      config: { ...DEFAULT_QUALITY_GATE_CONFIG, resolutionRateBaseline: 0 },
    });
    expect(rated.checks.satisfactionMinimum.noData).toBe(false);
    expect(rated.checks.satisfactionMinimum.passed).toBe(false);
    expect(rated.passed).toBe(false);
  });
});
