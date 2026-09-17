/**
 * 构造数据与决策带的测试。
 *
 * 这个文件里最有价值的一组断言不是构造出来的，而是把**真实跑出来的**分布写死：
 * 30 条种子查询经真 embedding + 真 reranker（BAAI/bge-reranker-v2-m3）打真知识库
 * 得到的 topScore（数据来源：`pnpm synthetic:data`，2026-09-15）。
 *
 * 有了它，两个结论就从"我记得"变成"可回归"：
 * 1. 默认 0.35 在这份分布上召回不到 90%——它不是保守，而是偏低；
 * 2. 两类之间那条可行阈值带只有 0.084 宽，且由两条样本撑起来——很脆。
 */
import { describe, expect, it } from "vitest";

import {
  decisionBand,
  describeBandStability,
  thresholdTradeoff,
  topOf,
  type BandSample,
} from "../confidence/margin";
import {
  buildSyntheticRecords,
  dominantRiskStratum,
  labelForStratum,
  SeedQuerySetSchema,
  splitSections,
  validateSeedSet,
  type KbSection,
  type SeedQuerySet,
} from "../confidence/synthetic";
import {
  ConfidenceProfileSchema,
  describeResolution,
  resolveProfile,
  UNCALIBRATED_PROFILE,
  type ConfidenceProfile,
} from "../confidence/profile";
import { resolveProvenance, type CalibrationRecord } from "../confidence/calibration-runner";
import type { LabeledCaseWithChunks } from "../confidence/calibration";

/** 把 topScore 向量包成闸门要的输入（决策带只看 top，用单元素即可） */
const caseOf = (id: string, top: number, shouldEscalate: boolean): LabeledCaseWithChunks => ({
  id,
  score: top,
  shouldEscalate,
  chunkScores: [top],
});

// ─────────────────────────────────────────────────────────────
// 真实测得的分布（2026-09-15，pnpm synthetic:data，真 reranker）
// ─────────────────────────────────────────────────────────────
const REAL_NEGATIVES: Array<[string, number]> = [
  // 可答：答案在知识库里
  ["A1", 0.9667],
  ["A2", 0.9414],
  ["A3", 0.5929],
  ["A4", 0.6925],
  ["A5", 0.9525],
  ["A6", 0.9763],
  ["A7", 0.8952],
  ["A8", 0.9891],
  ["A9", 0.9886],
  ["A10", 0.5702],
  ["A11", 0.9072],
  ["A12", 0.4767],
];
const REAL_POSITIVES: Array<[string, number]> = [
  // 域外：话题完全不在库里
  ["B1", 0.0033],
  ["B2", 0.0419],
  ["B3", 0.0003],
  ["B4", 0.0016],
  ["B5", 0.0002],
  ["B6", 0.0002],
  ["B7", 0.001],
  ["B8", 0.0004],
  ["B9", 0.0029],
  ["B10", 0.0006],
  // 邻近缺参：话题在库里、具体答案不在（群像高发区）
  ["C1", 0.0198],
  ["C2", 0.3764],
  ["C3", 0.0559],
  ["C4", 0.1895],
  ["C5", 0.3534],
  ["C6", 0.0044],
  ["C7", 0.0299],
  ["C8", 0.3926],
];
const REAL_CASES: LabeledCaseWithChunks[] = [
  ...REAL_NEGATIVES.map(([id, top]) => caseOf(id, top, false)),
  ...REAL_POSITIVES.map(([id, top]) => caseOf(id, top, true)),
];

describe("决策带（只依赖类内分布）", () => {
  it("完全可分：给出可行区间、中点，并指认决定带宽的两条样本", () => {
    const band = decisionBand([
      caseOf("n1", 0.9, false),
      caseOf("n2", 0.7, false),
      caseOf("p1", 0.2, true),
      caseOf("p2", 0.1, true),
    ]);

    expect(band.separable).toBe(true);
    // 正类要低分、负类要高分：low = 最简单的正样本(0.2)，high = 最难的负样本(0.7)
    expect(band.low).toBeCloseTo(0.2, 4);
    expect(band.high).toBeCloseTo(0.7, 4);
    expect(band.width).toBeCloseTo(0.5, 4);
    expect(band.midpoint).toBeCloseTo(0.45, 4);
    expect(band.limiting.easiestPositive?.id).toBe("p1");
    expect(band.limiting.hardestNegative?.id).toBe("n2");
    expect(band.inversions).toHaveLength(0);
  });

  it("倒置时判不可分，不给中点，并列出倒置对与落在重叠区的样本", () => {
    const band = decisionBand([
      caseOf("n1", 0.9, false),
      caseOf("n2", 0.3, false), // 负样本分数比正样本还低
      caseOf("p1", 0.4, true),
    ]);

    expect(band.separable).toBe(false);
    // 关键：不可分时不给一个"看着能用"的数
    expect(band.midpoint).toBeNull();
    expect(band.width).toBeLessThan(0);
    expect(band.inversions).toHaveLength(1);
    expect(band.inversions[0]?.negativeId).toBe("n2");
    expect(band.inversions[0]?.positiveId).toBe("p1");
    expect(band.overlapping.map((s: BandSample) => s.id).sort()).toEqual(["n2", "p1"]);
    expect(band.reason).toContain("不可分");
  });

  it("单类样本：明确说无从谈起，而不是返回一个默认区间", () => {
    const onlyNegatives = decisionBand([caseOf("n1", 0.9, false)]);
    expect(onlyNegatives.separable).toBe(false);
    expect(onlyNegatives.midpoint).toBeNull();
    expect(onlyNegatives.reason).toContain("没有正类样本");

    const onlyPositives = decisionBand([caseOf("p1", 0.1, true)]);
    expect(onlyPositives.reason).toContain("没有负类样本");
  });

  it("真实测得的分布：可行区间 (0.3926, 0.4767]，带宽仅 0.084", () => {
    const strata = new Map<string, string>();
    for (const [id] of REAL_NEGATIVES) strata.set(id, "answerable");
    for (const [id] of REAL_POSITIVES) {
      strata.set(id, id.startsWith("B") ? "out_of_scope" : "near_miss");
    }
    const band = decisionBand(REAL_CASES, strata);

    expect(band.positives).toBe(18);
    expect(band.negatives).toBe(12);
    expect(band.separable).toBe(true);
    // 最难的负样本是 A12（注销账号怎么问才算答得了），最简单的正样本是 C8（积分兑换实物的售后）
    expect(band.high).toBeCloseTo(0.4767, 4);
    expect(band.low).toBeCloseTo(0.3926, 4);
    expect(band.width).toBeCloseTo(0.0841, 4);
    expect(band.midpoint).toBeCloseTo(0.4346, 3);
    expect(band.limiting.hardestNegative?.id).toBe("A12");
    expect(band.limiting.easiestPositive?.id).toBe("C8");
    // 正类里分数最高的那条来自 near_miss —— 群像高发区，与理论预期一致。
    // 这是本轮最重要的定性结论：撑住上界的不是"话题完全不在库"的那批，
    // 而是"话题在库、答案不在"的那批。
    expect(band.limiting.easiestPositive?.stratum).toBe("near_miss");
  });

  it("真实分布的带宽是脆的：拿掉决定它的单条样本，带宽变化比带宽本身还大", () => {
    const band = decisionBand(REAL_CASES);
    const stability = describeBandStability(band);

    expect(band.widthWithoutHardestNegative).not.toBeNull();
    expect(band.widthWithoutEasiestPositive).not.toBeNull();
    // 由单条样本撑起 → 必须被标成"不是稳健证据"，而不是"带宽 0.084 够用"
    expect(stability).toContain("不是稳健证据");
  });

  it("默认 0.35 在这份分布上召回不到 90%：它不是保守，是偏低", () => {
    const rows = thresholdTradeoff(REAL_CASES, { thresholds: [0.35] });
    const row = rows[0];

    expect(row).toBeDefined();
    // 0.35 会放行三条「知识库答不了」的问题：
    //   C2=0.3764（成长值会不会过期）、C5=0.3534（换开收不收手续费）、C8=0.3926（积分兑换实物的售后）
    // 三条都来自 near_miss 地层——话题在库里、具体答案不在。
    expect(row?.tpr).toBeCloseTo(15 / 18, 4);
    expect(row?.tpr).toBeLessThan(0.9);
    expect(row?.tp).toBe(15);
    expect(row?.positives).toBe(18);
    expect(row?.fpr).toBe(0);

    // 而把阈值提到最难的负样本之上，就能做到召回 100% 且零误伤
    const safe = thresholdTradeoff(REAL_CASES, { thresholds: [0.4767] })[0];
    expect(safe?.tpr).toBe(1);
    expect(safe?.fpr).toBe(0);
    expect(safe?.tp).toBe(18);
  });

  it("取舍表是类内比例：把样本复制十倍不改变 tpr/fpr（所以与流行度无关）", () => {
    const duplicated: LabeledCaseWithChunks[] = [...REAL_CASES, ...REAL_CASES, ...REAL_CASES].map(
      (item, index) => ({ ...item, id: `${item.id}-${index}` }),
    );

    const base = thresholdTradeoff(REAL_CASES, { thresholds: [0.35, 0.4767] });
    const dup = thresholdTradeoff(duplicated, { thresholds: [0.35, 0.4767] });

    expect(dup.map((r) => r.tpr)).toEqual(base.map((r) => r.tpr));
    expect(dup.map((r) => r.fpr)).toEqual(base.map((r) => r.fpr));
  });

  it("topOf：空分布按最低处理，与生产实现一致", () => {
    expect(topOf([])).toBe(0);
    expect(topOf([0.2, 0.9, 0.1])).toBe(0.9);
  });
});

describe("知识库切块与种子集体检", () => {
  const markdown = [
    "# 测试手册",
    "",
    "## 第一节",
    "内容甲。",
    "",
    "## 第二节",
    "内容乙。",
    "",
  ].join("\n");

  it("按二级标题切分，并把文首标题块拼进每个章节（保留上下文）", () => {
    const { sections, oversizedSections } = splitSections("doc.md", markdown);

    expect(sections).toHaveLength(2);
    expect(oversizedSections).toBe(0);
    expect(sections[0]?.id).toBe("doc.md#第一节");
    expect(sections[0]?.heading).toBe("第一节");
    // 标题块被 prepend，章节文本紧随其后
    expect(sections[0]?.content).toContain("# 测试手册");
    expect(sections[0]?.content).toContain("内容甲。");
    expect(sections[1]?.content).toContain("内容乙。");
  });

  it("没有二级标题时整篇当一个块，不静默丢内容", () => {
    const { sections } = splitSections("plain.md", "# 只有标题\n\n正文。\n");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe("全文");
    expect(sections[0]?.content).toContain("正文。");
  });

  it("超长章节被二次切分，且如实报出近似切分的章节数", () => {
    const long = `# T\n\n## 长节\n\n${"段落。".repeat(400)}\n`;
    const { sections, oversizedSections } = splitSections("long.md", long, { chunkSize: 200 });

    expect(oversizedSections).toBe(1);
    expect(sections.length).toBeGreaterThan(1);
    // 多次切分时 id 带序号，保证唯一
    expect(sections[0]?.id).toContain("#1");
  });

  it("地层 → 标签：只有 answerable 是负类", () => {
    expect(labelForStratum("answerable")).toBe(false);
    expect(labelForStratum("near_miss")).toBe(true);
    expect(labelForStratum("out_of_scope")).toBe(true);
  });

  it("体检拦住会让标签静默错掉的问题", () => {
    const sections: KbSection[] = [
      { id: "doc.md#甲", doc: "doc.md", heading: "甲", content: "x" },
    ];
    const bad = SeedQuerySetSchema.parse({
      kbVersion: "v",
      domain: "d",
      queries: [
        // answerable 却不给 target → 无法自检，必须报错
        { id: "q1", stratum: "answerable", q: "问题一", basis: "依据" },
        // target 指向不存在的块 → 通常是文件名打错
        {
          id: "q2",
          stratum: "answerable",
          q: "问题二",
          target: ["doc.md#不存在"],
          basis: "依据",
        },
        { id: "q1", stratum: "out_of_scope", q: "重复 id", basis: "依据" },
      ],
    });

    const result = validateSeedSet(bad, sections);
    expect(result.errors.join("\n")).toContain("没给 target");
    expect(result.errors.join("\n")).toContain("不存在于知识库切块");
    expect(result.errors.join("\n")).toContain("重复");
    // 没有 near_miss 只是警告，不阻断——但必须被说出来
    expect(result.warnings.join("\n")).toContain("near_miss");
  });
});

describe("构造数据集装配", () => {
  const set: SeedQuerySet = SeedQuerySetSchema.parse({
    kbVersion: "kb-test",
    domain: "测试域",
    queries: [
      {
        id: "a1",
        stratum: "answerable",
        q: "答得出来的问题",
        target: ["doc.md#甲"],
        basis: "甲章节写了",
      },
      { id: "c1", stratum: "near_miss", q: "邻近缺参的问题", basis: "相邻规则存在但答案缺失" },
      { id: "b1", stratum: "out_of_scope", q: "域外的问题", basis: "完全不涉及" },
    ],
  });

  it("产出恒为 constructed，标签由地层决定", () => {
    const { records } = buildSyntheticRecords({
      set,
      rerankerModel: "test-reranker",
      scores: new Map([
        ["a1", [0.9]],
        ["c1", [0.36]],
        ["b1", [0.01]],
      ]),
      retrieved: new Map([
        ["a1", ["doc.md#甲"]],
        ["c1", ["doc.md#乙"]],
        ["b1", ["doc.md#乙"]],
      ]),
    });

    expect(records.map((r) => [r.id, r.shouldEscalate, r.provenance])).toEqual([
      ["a1", false, "constructed"],
      ["c1", true, "constructed"],
      ["b1", true, "constructed"],
    ]);
  });

  it("可答样本没召回到目标块 → 剔除并报出（否则会变成错标的正类）", () => {
    const { records, manifest } = buildSyntheticRecords({
      set,
      rerankerModel: "test-reranker",
      scores: new Map([
        ["a1", [0.05]],
        ["c1", [0.36]],
        ["b1", [0.01]],
      ]),
      // a1 的目标块没被召回：它的低分来自"检索没打中"，不是"知识库没有"
      retrieved: new Map([
        ["a1", ["doc.md#乙"]],
        ["c1", ["doc.md#乙"]],
        ["b1", ["doc.md#乙"]],
      ]),
    });

    expect(records.map((r) => r.id)).toEqual(["c1", "b1"]);
    expect(manifest.droppedAnswerableMisses).toEqual(["a1"]);
    expect(manifest.warnings.join("\n")).toContain("检索没打中");

    // 定性后果：错标的负类被剔掉后，负类不能为负
    expect(manifest.negatives).toBe(0);
  });

  it("清单始终带着诚实声明，且明说流行度是构造的", () => {
    const { manifest } = buildSyntheticRecords({
      set,
      rerankerModel: "test-reranker",
      scores: new Map([
        ["a1", [0.9]],
        ["c1", [0.36]],
        ["b1", [0.01]],
      ]),
    });

    const text = manifest.caveats.join("\n");
    expect(text).toContain("分数是真的");
    expect(text).toContain("标签是构造的");
    expect(text).toContain("流行度是编的");
    // 关键的一句：真实阈值大概率不低于构造数据给出的估计
    expect(text).toContain("下限附近");
    expect(manifest.positiveShare).toBeCloseTo(2 / 3, 4);
  });

  it("指认风险来自哪个地层：分数最高的正样本属于 near_miss", () => {
    const { records } = buildSyntheticRecords({
      set,
      rerankerModel: "test-reranker",
      scores: new Map([
        ["a1", [0.9]],
        ["c1", [0.36]],
        ["b1", [0.01]],
      ]),
    });

    const risk = dominantRiskStratum(records);
    expect(risk?.id).toBe("c1");
    expect(risk?.stratum).toBe("near_miss");
    expect(risk?.topScore).toBeCloseTo(0.36, 4);
  });
});

describe("provenance 守卫：构造数据不得被当成已标定", () => {
  const base = {
    profileVersion: "v1",
    rerankerModel: "m",
    kbVersion: "kb",
    domain: "d",
  };

  it("calibrated=true 配 constructed 直接拒绝解析", () => {
    expect(() =>
      ConfidenceProfileSchema.parse({ ...base, calibrated: true, provenance: "constructed" }),
    ).toThrow(/measured/);
  });

  it("calibrated=true 但没声明出处（默认 none）同样拒绝", () => {
    expect(() => ConfidenceProfileSchema.parse({ ...base, calibrated: true })).toThrow(/none/);
  });

  it("calibrated=true 配 measured 通过", () => {
    const profile = ConfidenceProfileSchema.parse({
      ...base,
      calibrated: true,
      provenance: "measured",
    });
    expect(profile.provenance).toBe("measured");
    expect(profile.provisional).toBe(false);
  });

  it("provisional 只允许「构造数据 + 未标定」这一种组合", () => {
    const ok = ConfidenceProfileSchema.parse({
      ...base,
      calibrated: false,
      provenance: "constructed",
      provisional: true,
    });
    expect(ok.provisional).toBe(true);

    // 标成 provisional 却又声称已标定 → 自相矛盾
    expect(() =>
      ConfidenceProfileSchema.parse({
        ...base,
        calibrated: true,
        provenance: "measured",
        provisional: true,
      }),
    ).toThrow(/provisional/);
  });

  it("混合组降级为 constructed：少量构造标签不能把整组洗成实测", () => {
    const record = (id: string, provenance: "measured" | "constructed"): CalibrationRecord => ({
      id,
      chunkScores: [0.5],
      score: 0.5,
      shouldEscalate: true,
      rerankerModel: "m",
      kbVersion: "kb",
      domain: "d",
      provenance,
    });

    const mixed = resolveProvenance([
      ...Array.from({ length: 50 }, (_, i) => record(`real-${i}`, "measured")),
      record("synthetic-1", "constructed"),
    ]);

    expect(mixed.provenance).toBe("constructed");
    expect(mixed.note).toContain("混入");
    expect(mixed.measuredCount).toBe(50);
    expect(mixed.constructedCount).toBe(1);

    const pure = resolveProvenance([record("a", "measured"), record("b", "measured")]);
    expect(pure.provenance).toBe("measured");
  });

  it("解析结果把 provisional 显式打出来：日志里必须能区分先验与实测", () => {
    const provisional: ConfidenceProfile = ConfidenceProfileSchema.parse({
      ...base,
      calibrated: false,
      provenance: "constructed",
      provisional: true,
    });

    const resolution = resolveProfile([provisional], {
      rerankerModel: "m",
      kbVersion: "kb",
      domain: "d",
    });

    expect(resolution.provisional).toBe(true);
    expect(resolution.calibrated).toBe(false);
    expect(describeResolution(resolution)).toBe("exact/provisional");
    // 不能只在 staleReasons 里悄悄提一句，要让调用方拿得到这个事实
    expect(resolution.staleReasons.join("\n")).toContain("过渡先验");

    // 对照：未标定默认值应显示成 uncalibrated，不能被误读成 provisional
    const fallback = resolveProfile([provisional], {
      rerankerModel: "m",
      kbVersion: "kb",
      domain: "其它域",
    });
    expect(fallback.profile).toEqual(UNCALIBRATED_PROFILE);
    expect(describeResolution(fallback)).toContain("uncalibrated");
  });
});
