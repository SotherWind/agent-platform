/**
 * 影子模式弱标签采集器测试
 *
 * 钉死三件事：
 * 1. 弱标签的**来源必须是真实用户行为**（转人工请求 / 重复提问 / 宿主确认解决），
 *    不是模型自评——否则就是让闸门给自己出题（见 synthetic.ts 文件头的循环论证警告）。
 * 2. 导出格式必须被 `calibrate --input` 的 schema 直接接受，且 provenance 是 measured。
 * 3. 未标记轮次绝不导出；空 chunkScores 绝不导出（标定硬前提）。
 */
import { describe, expect, it } from "vitest";
import {
  ShadowLabelCollector,
  questionSimilarity,
  type ShadowContext,
} from "../confidence/shadow-labels";
import { CalibrationRecordSchema } from "../confidence/calibration-runner";

const context: ShadowContext = {
  rerankerModel: "Qwen3-Reranker-4B",
  kbVersion: "kb-2026-09-live-knowledge",
  domain: "优选商城售后",
};

let clockValue = 1000;
function makeCollector(overrides: Partial<ConstructorParameters<typeof ShadowLabelCollector>[0]> = {}) {
  clockValue = 1000;
  return new ShadowLabelCollector({
    context,
    clock: () => (clockValue += 100),
    ...overrides,
  });
}

function recordKnowledgeTurn(
  collector: ShadowLabelCollector,
  input: { threadId?: string; query: string; lowConfidence?: boolean },
) {
  return collector.recordTurn({
    threadId: input.threadId ?? "th-1",
    tenantId: "t",
    query: input.query,
    chunkScores: [0.42, 0.31, 0.28],
    score: 0.4,
    lowConfidence: input.lowConfidence ?? false,
    threshold: 0.35,
    profile: "exact/provisional",
  });
}

describe("questionSimilarity", () => {
  it("同一问题的不同说法相似度高于默认阈值", () => {
    const a = "七天无理由退货的运费谁承担？";
    const b = "七天无理由退货运费是谁出";
    // 中文同义改写共享主体词而非句式，实测约 0.44；默认阈值 0.35 在其下方
    expect(questionSimilarity(a, b)).toBeGreaterThanOrEqual(0.35);
  });

  it("不同话题的相似度低于阈值", () => {
    expect(questionSimilarity("退款多久到账", "你们招人吗怎么投简历")).toBeLessThan(0.3);
  });

  it("标点与大小写不影响判定", () => {
    const base = questionSimilarity("积分能抵扣多少", "积分能抵扣多少钱");
    const noisy = questionSimilarity("积分能抵扣多少？？", "积分 能抵扣多少 钱。");
    expect(noisy).toBeCloseTo(base, 1);
  });
});

describe("ShadowLabelCollector 弱标签来源", () => {
  it("下一轮要求转人工 → 上一轮标为 shouldEscalate=true", () => {
    const collector = makeCollector();
    const turn = recordKnowledgeTurn(collector, { query: "退款多久到账？" });
    const labeled = collector.observeTurnStart({ threadId: "th-1", query: "别跟我绕，转人工" });

    expect(labeled).toHaveLength(1);
    expect(labeled[0]!.id).toBe(turn.id);
    expect(labeled[0]!.label?.shouldEscalate).toBe(true);
    expect(labeled[0]!.label?.basis).toBe("explicit_human_request");
  });

  it("下一轮换说法重复同一问题 → 标为 shouldEscalate=true", () => {
    const collector = makeCollector();
    recordKnowledgeTurn(collector, { query: "七天无理由退货的运费谁承担？" });
    const labeled = collector.observeTurnStart({
      threadId: "th-1",
      query: "七天无理由退货运费是谁出",
    });
    expect(labeled[0]!.label?.basis).toBe("repeated_question");
    expect(labeled[0]!.label?.shouldEscalate).toBe(true);
  });

  it("换了话题 → 不给标签（没信号不等于解决了）", () => {
    const collector = makeCollector();
    recordKnowledgeTurn(collector, { query: "退款多久到账？" });
    expect(collector.observeTurnStart({ threadId: "th-1", query: "你们招人吗" })).toHaveLength(0);
    expect(collector.stats().labeled).toBe(0);
  });

  it("宿主确认解决 → 唯一的负标签来源", () => {
    const collector = makeCollector();
    const turn = recordKnowledgeTurn(collector, { query: "价保周期多久？" });
    const marked = collector.markResolved("th-1");
    expect(marked?.id).toBe(turn.id);
    expect(marked?.label?.shouldEscalate).toBe(false);
    expect(marked?.label?.basis).toBe("session_resolved");
  });

  it("已标记的轮次不会被重复标记", () => {
    const collector = makeCollector();
    recordKnowledgeTurn(collector, { query: "退款多久到账？" });
    collector.observeTurnStart({ threadId: "th-1", query: "转人工" });
    expect(collector.observeTurnStart({ threadId: "th-1", query: "转人工" })).toHaveLength(0);
    expect(collector.markResolved("th-1")).toBeNull();
    expect(collector.stats().labeled).toBe(1);
  });

  it("不同线程互不干扰", () => {
    const collector = makeCollector();
    recordKnowledgeTurn(collector, { threadId: "a", query: "退款多久到账？" });
    recordKnowledgeTurn(collector, { threadId: "b", query: "价保周期多久？" });
    collector.observeTurnStart({ threadId: "a", query: "转人工" });
    const stats = collector.stats();
    expect(stats.labeled).toBe(1);
    expect(stats.positives).toBe(1);
    expect(collector.markResolved("b")?.label?.shouldEscalate).toBe(false);
  });
});

describe("导出与标定 schema 的兼容性", () => {
  it("导出的每一行都能被 CalibrationRecordSchema 解析", () => {
    const collector = makeCollector();
    recordKnowledgeTurn(collector, { query: "退款多久到账？" });
    collector.observeTurnStart({ threadId: "th-1", query: "转人工" });
    recordKnowledgeTurn(collector, { query: "价保周期多久？" });
    collector.markResolved("th-1");

    const lines = collector.toCalibrationJsonl().trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = CalibrationRecordSchema.parse(JSON.parse(line));
      // 标签来自真实用户行为，出处必须是 measured（不是 constructed）
      expect(parsed.provenance).toBe("measured");
      expect(parsed.rerankerModel).toBe(context.rerankerModel);
      expect(parsed.kbVersion).toBe(context.kbVersion);
      expect(parsed.domain).toBe(context.domain);
      expect(parsed.chunkScores.length).toBeGreaterThan(0);
    }
  });

  it("未标记轮次与空 chunkScores 的记录都不导出", () => {
    const collector = makeCollector();
    recordKnowledgeTurn(collector, { query: "没人理的问题" });
    collector.recordTurn({
      threadId: "th-empty",
      query: "零召回",
      chunkScores: [],
      score: 0,
      lowConfidence: true,
    });
    collector.observeTurnStart({ threadId: "th-empty", query: "转人工" });
    expect(collector.toCalibrationJsonl()).toBe("");
  });

  it("stats 反映正负标签计数（标定门槛要求每类 >=50）", () => {
    const collector = makeCollector();
    for (const q of ["问题一", "问题二", "问题三"]) {
      recordKnowledgeTurn(collector, { threadId: `th-${q}`, query: q });
    }
    collector.observeTurnStart({ threadId: "th-问题一", query: "转人工" });
    collector.markResolved("th-问题二");
    expect(collector.stats()).toEqual({ total: 3, labeled: 2, positives: 1, negatives: 1 });
  });

  it("list 返回副本，外部改动不会污染采集器", () => {
    const collector = makeCollector();
    const turn = recordKnowledgeTurn(collector, { query: "退款多久到账？" });
    const snapshot = collector.list();
    snapshot[0]!.chunkScores = [999];
    expect(collector.list()[0]!.chunkScores).toEqual(turn.chunkScores);
  });
});
