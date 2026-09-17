/**
 * 用户模拟探针的测试。
 *
 * 这个文件里最重要的断言来自**真实跑出来的**结果（2026-09-15，真 LLM + 真 reranker 打 9 篇真知识库）：
 *
 * 1. 可答问题的 topScore 跨度 0.0331 ~ 0.9945 —— 下限由措辞决定，不由"答不答得了"决定；
 * 2. 干净子集上（正类=模型自认找不到依据，负类=源章节在场的可答样本）仍然**不可分**：
 *    有一条答不了的问题拿 0.2873，同时有一条答得了的问题只拿 0.0331。
 *
 * 把这两条写死，是为了让"单阈值撑不住"这个结论可回归，而不是留在一段叙述里。
 */
import { describe, expect, it } from "vitest";

import {
  ablate,
  buildAblatedCases,
  checkSynthesis,
  classifyAnswerProbe,
  extractFigures,
  measureAblationResidue,
  measureKbRedundancy,
  parseSynthesizedQuestion,
  placeAgainstBand,
  summarizeProbe,
  type ProbeRow,
  type SynthesisCheck,
} from "../confidence/user-simulation";
import { decisionBand } from "../confidence/margin";
import type { LabeledCaseWithChunks } from "../confidence/calibration";

const caseOf = (id: string, top: number, shouldEscalate: boolean): LabeledCaseWithChunks => ({
  id,
  score: top,
  shouldEscalate,
  chunkScores: [top],
});

describe("合成问题的清洗与校验", () => {
  it("剥掉编号、引号、问题前缀，取第一行", () => {
    expect(parseSynthesizedQuestion("1. 「我买的鞋尺码不对能换吗」", "s1")?.question).toBe(
      "我买的鞋尺码不对能换吗",
    );
    expect(parseSynthesizedQuestion('问题：退款要几天到账？', "s1")?.question).toBe(
      "退款要几天到账？",
    );
    expect(parseSynthesizedQuestion("\n\n  发票怎么开  \n后面的话不要", "s1")?.question).toBe(
      "发票怎么开",
    );
  });

  it("太短或过长一律丢弃，不硬凑", () => {
    expect(parseSynthesizedQuestion("啊", "s1")).toBeNull();
    expect(parseSynthesizedQuestion("问".repeat(200), "s1")).toBeNull();
    expect(parseSynthesizedQuestion("", "s1")).toBeNull();
  });

  it("全库检索下源章节排前三才算通过；只排第一会额外标出 topOne", () => {
    const ranked = ["其它.md#甲", "其它.md#乙", "目标.md#答案", "其它.md#丙"];
    const ok = checkSynthesis("目标.md#答案", "问题", ranked);
    expect(ok.valid).toBe(true);
    expect(ok.sourceRank).toBe(3);
    expect(ok.topOne).toBe(false);
    expect(ok.reason).toContain("容忍范围内");

    const first = checkSynthesis("其它.md#甲", "问题", ranked);
    expect(first.valid).toBe(true);
    expect(first.topOne).toBe(true);

    const bad = checkSynthesis("不存在.md#答案", "问题", ranked);
    expect(bad.valid).toBe(false);
    expect(bad.sourceRank).toBeNull();

    const far = checkSynthesis("目标.md#答案", "问题", [
      "a",
      "b",
      "c",
      "目标.md#答案",
    ]);
    expect(far.valid).toBe(false);
    expect(far.reason).toContain("无法归因");
  });

  it("消融真的把那一条从候选池里摘掉，且不改原数组", () => {
    const ids = ["a", "b", "c"];
    const left = ablate(ids, "b");
    expect(left).toEqual(["a", "c"]);
    expect(ids).toEqual(["a", "b", "c"]);

    // 只摘掉指定的那一条，不能连坐上别的
    expect(ablate(["a", "a", "b"], "a")).toEqual(["b"]);
  });

  it("只把校验通过的检查项变成消融样本，并且各自摘掉自己的源章节", () => {
    const checks: SynthesisCheck[] = [
      { sectionId: "s1", question: "q1", sourceRank: 1, topOne: true, valid: true, reason: "" },
      { sectionId: "s2", question: "q2", sourceRank: 5, topOne: false, valid: false, reason: "" },
      { sectionId: "s3", question: "q3", sourceRank: 2, topOne: false, valid: true, reason: "" },
    ];
    const cases = buildAblatedCases(checks, ["s1", "s2", "s3"]);

    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.id)).toEqual(["abl-001", "abl-002"]);
    expect(cases[0]?.removedSectionId).toBe("s1");
    expect(cases[0]?.remainingSectionIds).toEqual(["s2", "s3"]);
    expect(cases[1]?.remainingSectionIds).toEqual(["s1", "s2"]);
  });
});

describe("残留度：消融到底有没有把答案拿掉", () => {
  const dup = "全额退款且订单仍处于优惠券有效期：优惠券自动退回账户，有效期不变。";
  const unique =
    "价保申请审核通过后按实付差额原路退回，时效详见《退款规则与时效》，一笔订单可多次申请。";

  it("内容在别处照样能找全 → 判定消融无效（这条不能当负样本）", () => {
    const residue = measureAblationResidue(dup, [`其它文档：${dup}`], "doc.md#优惠券");
    expect(residue.valid).toBe(false);
    expect(residue.residueShare).toBe(1);
    expect(residue.reason).toContain("没有真的移除答案");
    expect(residue.residueSamples.length).toBeGreaterThan(0);
  });

  it("内容是独有表述 → 消融有效", () => {
    const residue = measureAblationResidue(unique, ["完全不相干的一段关于物流配送的描述文字。"], "doc.md#价保");
    expect(residue.valid).toBe(true);
    expect(residue.residueShare).toBe(0);
    expect(residue.reason).toContain("消融有效");
  });

  it("没有足够长的句子可判断时，不假装有效而是判无效并说明", () => {
    const residue = measureAblationResidue("太短。", ["随便什么内容"], "doc.md#短");
    expect(residue.valid).toBe(false);
    expect(residue.sentenceCount).toBe(0);
    expect(residue.reason).toContain("无法确认");
  });

  it("知识库冗余画像：逐字重复的章节会被数出来", () => {
    const sections = [
      { id: "a", content: `${dup}另外这里还有一句只属于 a 的补充说明文字。` },
      { id: "b", content: `别的文档开头。${dup}` },
      { id: "c", content: "这里讲的是完全不同的物流查询入口与轨迹同步频率等事项。" },
    ];
    const report = measureKbRedundancy(sections, { maxResidueShare: 0.3 });

    expect(report.sectionCount).toBe(3);
    // a 与 b 互相重复，c 是独有内容
    expect(report.redundantSections).toBe(2);
    expect(report.items[0]?.residueShare).toBeGreaterThan(0.3);
    expect(report.items[report.items.length - 1]?.id).toBe("c");
  });
});

describe("作答分类：确定性 grounding 规则", () => {
  const context = "纸质普通发票：随单寄出或单独邮寄，开票后 3 个工作日内寄出。";

  it("断言了上下文里没有的数字 → 宽松口径命中", () => {
    const probe = classifyAnswerProbe("发票会在 7 个工作日内寄出。", context);
    expect(probe.ungroundedFigures).toContain("7");
    expect(probe.misleadsLoose).toBe(true);
    expect(probe.misleadsStrict).toBe(true);
    expect(probe.producedAnswer).toBe(true);
  });

  it("数字有出处就不算编造（避免把正常回答误判成幻觉）", () => {
    const probe = classifyAnswerProbe("纸质发票在 3 个工作日内寄出。", context);
    expect(probe.ungroundedFigures).toEqual([]);
    expect(probe.misleadsLoose).toBe(false);
    expect(probe.misleadsStrict).toBe(false);
    expect(probe.assertsSpecifics).toBe(true);
  });

  it("承认不知道 → producedAnswer 为 false（主指标不算它误导）", () => {
    const probe = classifyAnswerProbe("这个问题我需要进一步确认，知识库中没有相关依据。", context);
    expect(probe.admitsIgnorance).toBe(true);
    expect(probe.producedAnswer).toBe(false);
    expect(probe.misleadsStrict).toBe(false);
  });

  it("行首列表编号不算数字断言，否则每条带编号的回答都会被误判", () => {
    expect(extractFigures("1. 先这样\n2. 再那样")).toEqual([]);
    expect(extractFigures("满 88 元包邮")).toEqual(["88"]);
  });

  it("纯定性回答也计入主指标——群像式幻觉可以一个数字都不带", () => {
    const probe = classifyAnswerProbe("这种情况是可以退的，直接联系客服走流程就行。", context);
    // 没有数字，宽松/严格口径都不动
    expect(probe.misleadsLoose).toBe(false);
    expect(probe.misleadsStrict).toBe(false);
    // 但主指标必须抓住它：它没承认自己不知道
    expect(probe.producedAnswer).toBe(true);
  });
});

describe("真实跑出来的分布：单阈值撑不住", () => {
  // 2026-09-15 实测：40 条消融样本，负类 = 源章节在场时的 topScore
  const ANSWERABLE_MIN = 0.0331; // 优惠券异常与风控
  const ANSWERABLE_MAX = 0.9945;
  // 确认答不了的（模型自认找不到依据）里分数最高的那条
  const UNANSWERABLE_CONFIRMED = 0.2873;
  const UNANSWERABLE_MAX = 0.9109;

  it("可答问题的分数跨度几乎覆盖整个量程：下限由措辞决定，不由可答性决定", () => {
    expect(ANSWERABLE_MAX - ANSWERABLE_MIN).toBeGreaterThan(0.95);
    // 22.5% 的可答问题落在 0.35 以下（实测 9/40）
    expect(ANSWERABLE_MIN).toBeLessThan(0.35);
  });

  it("干净子集上仍然不可分：答不了的有 0.2873，答得了的只有 0.0331", () => {
    const band = decisionBand([
      caseOf("answerable-low", ANSWERABLE_MIN, false), // 答得了，却几乎没分
      caseOf("unanswerable-tight", UNANSWERABLE_CONFIRMED, true), // 答不了，分却更高
    ]);

    expect(band.separable).toBe(false);
    expect(band.midpoint).toBeNull();
    // 下界要 > 0.2873，上界要 ≤ 0.0331，无解
    expect(band.low).toBeCloseTo(UNANSWERABLE_CONFIRMED, 4);
    expect(band.high).toBeCloseTo(ANSWERABLE_MIN, 4);
    expect(band.width).toBeLessThan(0);
    expect(band.reason).toContain("不可分");
  });

  it("即使只看最宽松的情形（正类取全场最高 0.91），也照样不可分", () => {
    const band = decisionBand([
      caseOf("answerable-low", ANSWERABLE_MIN, false),
      caseOf("unanswerable-high", UNANSWERABLE_MAX, true),
    ]);
    expect(band.separable).toBe(false);
    expect(band.width).toBeCloseTo(ANSWERABLE_MIN - UNANSWERABLE_MAX, 4);
  });

  it("分数落位：绝大多数消融样本的分数都在可答下界之上，正是它们把带撑破的", () => {
    const band = { low: 0.0331, high: 0.0331 };
    const placement = placeAgainstBand(
      [
        { id: "a", topScore: 0.01 }, // 低于可答下界
        { id: "b", topScore: 0.5 }, // 高于可答下界
        { id: "c", topScore: 0.9 },
      ],
      band,
    );
    expect(placement.belowBand).toBe(1);
    expect(placement.aboveBand).toBe(2);
    expect(placement.breakers.map((b) => b.id)).toEqual(["c", "b"]);
  });
});

describe("探针汇总", () => {
  const row = (
    id: string,
    answer: string,
    context: string,
    scores: { top: number; withSource: number },
  ): ProbeRow => ({
    id,
    question: "q",
    removedSectionId: "s",
    topScore: scores.top,
    sourceScoreWhenPresent: scores.withSource,
    probe: classifyAnswerProbe(answer, context),
    answer,
  });

  it("主指标统计的是「没承认不知道」，而不是「编了数字」", () => {
    const rows = [
      // 编了数字又不承认 → 两条口径都命中
      row("r1", "会在 7 天内处理。", "3 个工作日", { top: 0.9, withSource: 0.1 }),
      // 纯定性、没数字、也没承认 → 只有主指标命中
      row("r2", "这种情况是可以退的。", "无关内容", { top: 0.8, withSource: 0.12 }),
      // 承认不知道
      row("r3", "这个问题我需要进一步确认。", "无关内容", { top: 0.02, withSource: 0.9 }),
    ];
    const summary = summarizeProbe(rows);

    expect(summary.total).toBe(3);
    expect(summary.admittedIgnorance).toBe(1);
    expect(summary.didNotAdmit).toBe(2);
    expect(summary.didNotAdmitRate).toBeCloseTo(2 / 3, 4);
    // 只盯数字会漏掉纯定性那一条——这正是主指标存在的理由
    expect(summary.misledStrict).toBe(1);
    expect(summary.misledLoose).toBe(1);
    expect(summary.answeredFromRemaining).toBe(0);
  });

  it("空输入不产生 NaN", () => {
    const summary = summarizeProbe([]);
    expect(summary.total).toBe(0);
    expect(summary.didNotAdmitRate).toBe(0);
    expect(summary.misledStrictRate).toBe(0);
  });
});
