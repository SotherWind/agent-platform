/**
 * 阈值标定与 profile 解析的测试。
 *
 * 这一组测试守的是「阈值不能靠拍」这件事本身：ROC/AUC 的算法要对，
 * 工作点的选择准则要在约束不可满足时说实话，profile 在换模型/换库时必须标 stale。
 *
 * 纯函数，无网络、无 .env、无原生模块。
 */
import {
  auc,
  canCalibrate,
  chooseSolid,
  chooseThreshold,
  defaultPolicyGrid,
  derivePolicyGrid,
  gateConfusion,
  judgeGeneralization,
  populationStabilityIndex,
  prCurve,
  quantileCandidates,
  refinePolicy,
  rocCurve,
  scoreDistribution,
  sensitivityReport,
  splitCases,
  summarizeSensitivity,
  sweepThresholds,
  wilsonInterval,
  type LabeledCase,
  type LabeledCaseWithChunks,
} from "../confidence/calibration";
import {
  ConfidenceProfileSchema,
  DEFAULT_CONFIDENCE_POLICY,
  describeResolution,
  resolveProfile,
  UNCALIBRATED_PROFILE,
  type ConfidenceProfile,
} from "../confidence/profile";
import {
  buildCalibrationRecord,
  calibrateGroup,
  createGateEvaluator,
  parseJsonl,
  profileFileName,
  type CalibrationRecord,
} from "../confidence/calibration-runner";

const caseOf = (id: string, score: number, shouldEscalate: boolean): LabeledCase => ({
  id,
  score,
  shouldEscalate,
});

/** 完全可分的数据：正类低分、负类高分 */
function separableCases(): LabeledCase[] {
  return [
    ...Array.from({ length: 100 }, (_, i) => caseOf(`p${i}`, 0.05 + i * 0.001, true)),
    ...Array.from({ length: 100 }, (_, i) => caseOf(`n${i}`, 0.85 + i * 0.001, false)),
  ];
}

const profileOf = (overrides: Partial<ConfidenceProfile> = {}): ConfidenceProfile =>
  ConfidenceProfileSchema.parse({
    profileVersion: "test-v1",
    rerankerModel: "Qwen3-Reranker-8B",
    kbVersion: "kb-2026-03",
    domain: "商品咨询",
    calibrated: true,
    // 实测标签才配得上 calibrated=true —— 守卫会强制这一点
    provenance: "measured",
    calibratedAt: "2026-03-01T00:00:00.000Z",
    sampleSize: 500,
    metrics: { auc: 0.91, tpr: 0.93, fpr: 0.11, precision: 0.94 },
    source: "handoff-2026Q1.jsonl",
    ...overrides,
  });

describe("标定数学", () => {
  it("完全可分的数据 AUC = 1，单类样本 AUC 无定义（null 而非编造）", () => {
    expect(auc(separableCases())).toBeCloseTo(1, 4);

    // 只有正类：AUC 在单类样本上没有定义，必须返回 null
    expect(auc([caseOf("a", 0.1, true), caseOf("b", 0.9, true)])).toBeNull();
    // 空样本同理
    expect(auc([])).toBeNull();
  });

  it("闸门方向正确：阈值越高抓得越多（TPR/FPR 同向单调）", () => {
    const points = sweepThresholds(separableCases());
    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1];
      const current = points[i];
      if (!previous || !current) continue;
      expect(current.tpr).toBeGreaterThanOrEqual(previous.tpr);
      expect(current.fpr).toBeGreaterThanOrEqual(previous.fpr);
    }

    // 标签与分数完全无关时，TPR 与 FPR 应该基本同步 → AUC 接近 0.5
    const noise: LabeledCase[] = [
      ...Array.from({ length: 50 }, (_, i) => caseOf(`x${i}`, 0.1 + i * 0.01, i % 2 === 0)),
      ...Array.from({ length: 50 }, (_, i) => caseOf(`y${i}`, 0.1 + i * 0.01, i % 2 === 1)),
    ];
    const noiseAuc = auc(noise);
    expect(noiseAuc).not.toBeNull();
    expect(noiseAuc as number).toBeGreaterThan(0.35);
    expect(noiseAuc as number).toBeLessThan(0.65);
  });

  it("PR 曲线按召回降序排列，precision 在无预测正例时以 1 呈现但可由 tp+fp 看出", () => {
    const curve = prCurve(separableCases());
    for (let i = 1; i < curve.length; i += 1) {
      const previous = curve[i - 1];
      const current = curve[i];
      if (!previous || !current) continue;
      expect(current.tpr).toBeLessThanOrEqual(previous.tpr);
    }
    // 阈值最低的点不会预测任何正例：tp+fp=0，precision 记 1 但不具信息量
    const lowest = curve[curve.length - 1];
    expect(lowest?.tp).toBe(0);
    expect(lowest?.tp + (lowest?.fp ?? 0)).toBe(0);
  });

  it("Wilson 区间随样本量收窄——这正是「样本够不够」的可读依据", () => {
    const tiny = wilsonInterval(3, 3);
    const large = wilsonInterval(300, 300);
    expect(large.high).toBeCloseTo(1, 4);
    expect(large.low).toBeGreaterThan(tiny.low);
    // 小样本即使 100% 也不该给出 [1,1] 这种荒谬结论
    expect(tiny.low).toBeGreaterThan(0);
    expect(tiny.low).toBeLessThan(0.5);
    // 区间必须落在 [0,1]
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("观测到 0 次误伤，区间上界也不是 0——0/100 不等于「误伤率必为 0」", () => {
    // 这是标定报告必须诚实的地方：100 条负样本里一次误伤都没发生，
    // 真实误伤率的上界仍约 3.7%（Wilson），量级与「经验法则 3/n」一致。
    const interval = wilsonInterval(0, 100);
    expect(interval.low).toBe(0);
    expect(interval.high).toBeGreaterThan(0);
    expect(interval.high).toBeLessThan(0.05);
  });

  it("样本不足时拒绝标定，且说清楚缺在哪", () => {
    const small = Array.from({ length: 30 }, (_, i) => caseOf(`s${i}`, 0.2, i < 25));
    const check = canCalibrate(small, { minSample: 200, minPositives: 50, minNegatives: 50 });
    expect(check.ok).toBe(false);
    expect(check.reasons.join("\n")).toContain("总样本");
    expect(check.reasons.join("\n")).toContain("正类");
    expect(check.reasons.join("\n")).toContain("负类");

    expect(canCalibrate(separableCases()).ok).toBe(true);
  });
});

describe("工作点选择", () => {
  it("可分数据上按召回下限选点：达标、误伤为 0", () => {
    const point = chooseThreshold(separableCases(), {
      mode: "recall_floor",
      targetRecall: 0.9,
      maxFpr: 0.3,
    });
    expect(point).not.toBeNull();
    expect(point?.metTarget).toBe(true);
    expect(point?.tpr).toBeGreaterThanOrEqual(0.9);
    expect(point?.fpr).toBe(0);
    expect(point?.positives).toBe(100);
    expect(point?.negatives).toBe(100);
    // 该点下点估计误伤为 0；上界非 0（Wilson 对 0/100 给出的上界约 3.7%），
    // 所以线上仍需按"误伤率可能到 3% 量级"来做容量与体验预估
    expect(point?.falsePositiveCi.low).toBe(0);
    expect(point?.falsePositiveCi.high).toBeLessThan(0.05);
  });

  it("召回与误伤无法同时满足时，如实标记 metTarget=false 而不是假装达标", () => {
    // 正负样本分数完全相同 → 任何阈值都分不开；满足召回下限只能靠"全部抓走"，
    // 而"全部抓走"的误伤是 100%，会被误伤上限拦下。
    const inseparable: LabeledCase[] = [
      ...Array.from({ length: 10 }, (_, i) => caseOf(`p${i}`, 0.5, true)),
      ...Array.from({ length: 10 }, (_, i) => caseOf(`n${i}`, 0.5, false)),
    ];
    const point = chooseThreshold(inseparable, {
      mode: "recall_floor",
      targetRecall: 0.9,
      maxFpr: 0.3,
    });
    expect(point?.metTarget).toBe(false);
    // 退让时选择"误伤上限内召回最高"的点，而不是"全部转人工"
    expect(point?.fpr).toBeLessThanOrEqual(0.3);
    expect(point?.maxFpr).toBe(0.3);
  });

  it("误伤上限缺省为 0.3，且可用 youden 作为对照口径", () => {
    const youden = chooseThreshold(separableCases(), { mode: "youden" });
    expect(youden?.mode).toBe("youden");
    expect(youden?.metTarget).toBe(true);
    expect(youden?.tpr).toBe(1);

    expect(chooseThreshold([])).toBeNull();
  });
});

describe("profile 解析与失效检测", () => {
  it("前提完全一致：命中已标定 profile，不标记 stale", () => {
    const resolution = resolveProfile([profileOf()], {
      rerankerModel: "Qwen3-Reranker-8B",
      kbVersion: "kb-2026-03",
      domain: "商品咨询",
    });
    expect(resolution.matchedBy).toBe("exact");
    expect(resolution.calibrated).toBe(true);
    expect(resolution.stale).toBe(false);
    expect(resolution.profile.floor).toBe(0.35);
    expect(describeResolution(resolution)).toBe("exact/measured");
  });

  it("换 reranker 模型：沿用旧阈值但显式标 stale 并说明原因", () => {
    const resolution = resolveProfile([profileOf()], {
      rerankerModel: "Qwen3-Reranker-4B",
      kbVersion: "kb-2026-03",
      domain: "商品咨询",
    });
    expect(resolution.matchedBy).toBe("domain");
    expect(resolution.stale).toBe(true);
    expect(resolution.staleReasons.join("\n")).toContain("reranker");
    expect(describeResolution(resolution)).toContain("stale");
  });

  it("知识库从 100 篇涨到 1 万篇：同样标 stale", () => {
    const resolution = resolveProfile([profileOf()], {
      rerankerModel: "Qwen3-Reranker-8B",
      kbVersion: "kb-2026-09-10k",
      domain: "商品咨询",
    });
    expect(resolution.stale).toBe(true);
    expect(resolution.staleReasons.join("\n")).toContain("知识库");
  });

  it("query 分布换域且无标定 profile：退回未标定默认值并标记未标定", () => {
    const resolution = resolveProfile([profileOf()], {
      rerankerModel: "Qwen3-Reranker-8B",
      kbVersion: "kb-2026-03",
      domain: "投诉工单",
    });
    expect(resolution.matchedBy).toBe("default");
    expect(resolution.calibrated).toBe(false);
    expect(resolution.stale).toBe(true);
    expect(resolution.profile).toEqual(UNCALIBRATED_PROFILE);

    // 完全没有 profiles 时也是同一条退路，不允许静默使用某个数字
    expect(resolveProfile(undefined, {
      rerankerModel: "x", kbVersion: "y", domain: "z",
    }).calibrated).toBe(false);
  });
});

describe("标定全流程（分阶段 + 尺度）", () => {
  const RERANK = "Qwen3-Reranker-8B";
  const KB = "kb-2026-03";
  const DOMAIN = "商品咨询";
  const KEY = `${RERANK}__${KB}__${DOMAIN}`;

  const OPTIONS = {
    mode: "recall_floor" as const,
    targetRecall: 0.9,
    minPrecision: 0.9,
    maxFpr: 0.3,
    minSample: 200,
    minPositives: 50,
    minNegatives: 50,
    force: false,
  };

  /** 群像式正类：一簇低分挤在一起，谁都领先不了（top ≤ 0.36） */
  const flockChunks = (top: number) => [top, top - 0.02, top - 0.03, top - 0.03, top - 0.04];
  /** 真命中负类：一条强命中 + 噪声（top ≥ 0.70） */
  const strongChunks = (top: number) => [top, top - 0.02, top - 0.04, 0.05, 0.02];

  /**
   * 完全可分的两支数据：正类 topScore ≤ 0.36，负类 topScore ∈ [0.70, 0.90]。
   * 用采集契约构造记录，避免手拼 score 导致"分布"与"合成分数"对不上。
   */
  const separableRecords = (): CalibrationRecord[] => {
    const rows: CalibrationRecord[] = [];
    for (let i = 0; i < 120; i += 1) {
      rows.push(
        buildCalibrationRecord({
          id: `p${i}`,
          chunkScores: flockChunks(0.30 + (i % 7) * 0.01),
          shouldEscalate: true,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    for (let i = 0; i < 120; i += 1) {
      rows.push(
        buildCalibrationRecord({
          id: `n${i}`,
          chunkScores: strongChunks(0.70 + (i % 21) * 0.01),
          shouldEscalate: false,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    return rows;
  };

  const maxTopOf = (records: CalibrationRecord[]) =>
    Math.max(...records.map((record) => Math.max(...record.chunkScores)));
  const minTopOf = (records: CalibrationRecord[]) =>
    Math.min(...records.map((record) => Math.max(...record.chunkScores)));

  it("分组标定产出带出处的 calibrated profile", () => {
    const records = separableRecords();
    const result = calibrateGroup(KEY, records, OPTIONS, undefined, () =>
      new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(result.skipped).toBe(false);
    expect(result.profile?.calibrated).toBe(true);
    expect(result.profile?.calibratedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(result.profile?.sampleSize).toBe(240);
    expect(result.profile?.rerankerModel).toBe(RERANK);
    // 判决函数在标注集上把两支分开了
    expect(result.confusion?.tpr).toBe(1);
    expect(result.confusion?.fpr).toBe(0);
    expect(result.confusion?.feasible).toBe(true);
    expect(result.auc).toBeCloseTo(1, 4);
    expect(result.refine?.evaluations).toBeGreaterThan(1);
    expect(result.notes.join("\n")).toContain("floor 标定");
    expect(result.notes.join("\n")).toContain("solid 标定");
    expect(result.profile?.source).toContain("scale=topScore");
  });

  it("★ 尺度回归：floor/solid 必须落在 rerank 分数尺度上，混用合成分数尺度会被这条抓住", () => {
    // 这是这次真正修掉的缺陷：floor 在 computeConfidence 里是与 topScore 比的，
    // 但早期实现把「合成分数尺度」上选出的阈值直接当 floor 用。
    // 合成分数量级更小（是 topScore 的折扣值），错位之后 floor 会跑到所有 topScore
    // 之上 —— 中间地带与群像判据整段失效，而单看 TPR/FPR 还不一定看得出来。
    const records = separableRecords();
    const result = calibrateGroup(KEY, records, OPTIONS);
    const profile = result.profile;
    expect(profile).toBeDefined();
    if (!profile) return;

    const minTop = minTopOf(records);
    const maxTop = maxTopOf(records);
    // floor / solid 都必须落在观测到的 topScore 区间内
    expect(profile.floor).toBeGreaterThanOrEqual(minTop);
    expect(profile.floor).toBeLessThanOrEqual(maxTop);
    expect(profile.solid).toBeGreaterThanOrEqual(minTop);
    expect(profile.solid).toBeLessThanOrEqual(maxTop);
    // 两根闸门不得交叉
    expect(profile.solid).toBeGreaterThanOrEqual(profile.floor);

    // 语义自证：用标定出的 policy 直接判，行为必须与两根闸门的定义一致
    const evaluate = createGateEvaluator();
    const policy = profile as unknown as Parameters<typeof evaluate>[1];
    // topScore 过了实心线 → 单条即可支撑，不得判低置信
    expect(evaluate([profile.solid + 0.01, 0.05], policy).lowConfidence).toBe(false);
    // topScore 低于下限 → 判低置信
    expect(evaluate([profile.floor - 0.01, profile.floor - 0.02], policy).lowConfidence).toBe(true);

    // 最锋利的一条：**中间地带必须真的存在且被用到**。
    // 尺度错位时 floor 会跑到观测 topScore 之上（或与 solid 挤在一起），
    // 于是所有样本都走"低于下限"或"高于实心线"，中间地带整段成为死代码——
    // 光看 TPR/FPR 完全看不出来（两者可能都还是 1 / 0）。
    const band = records.filter((row) => {
      const top = Math.max(...row.chunkScores);
      return !row.shouldEscalate && top >= profile.floor && top < profile.solid;
    });
    expect(band.length).toBeGreaterThan(0);
    for (const row of band) {
      // 落在中间地带的负类，必须靠"多段过线 + 区分度"的旁证被正当地放行
      expect(evaluate(row.chunkScores, policy).lowConfidence).toBe(false);
    }
  });

  it("坐标下降用中间地带把边界负类救回来（fpr 从 0.05 降到 0）", () => {
    // 这是"全参数标定"相对"只标 floor"的实际收益：初始的 floor 会把紧贴边界的负类
    // 判成低置信（它们是 FP）。把 floor 放宽、让它们落进中间地带后，
    // 靠「多段过线 + 区分度」的旁证被正当地放行。
    const records = separableRecords();
    const result = calibrateGroup(KEY, records, OPTIONS);
    expect(result.confusion?.tpr).toBe(1);
    expect(result.confusion?.fpr).toBe(0);
    expect(result.profile?.floor).toBeLessThan(result.profile?.solid ?? 0);
    // 放宽 floor 不是靠牺牲召回换来的
    expect(result.confusion?.fn).toBe(0);
  });

  it("样本不足时跳过而不是产出一个不可信的阈值", () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      buildCalibrationRecord({
        id: `r${i}`,
        chunkScores: flockChunks(0.2),
        shouldEscalate: i < 20,
        rerankerModel: RERANK,
        kbVersion: KB,
        domain: DOMAIN,
      }),
    );
    const result = calibrateGroup("k__v__d", records, OPTIONS);
    expect(result.skipped).toBe(true);
    expect(result.profile).toBeUndefined();
    expect(result.skipReasons.length).toBeGreaterThan(0);

    // --force 是显式越过：可以产出，但调用方已经知道它不可信
    const forced = calibrateGroup("k__v__d", records, { ...OPTIONS, force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.profile?.sampleSize).toBe(30);
  });

  it("JSONL 解析对字段缺失报错并指出行号，不静默跳过", () => {
    const ok = parseJsonl(
      '{"id":"a","chunkScores":[0.3,0.28,0.27],"shouldEscalate":true,"rerankerModel":"m","kbVersion":"v","domain":"d"}\n',
      "test.jsonl",
    );
    expect(ok).toHaveLength(1);
    // score 可缺省（按同一 policy 重算），chunkScores 不可缺
    expect(ok[0]?.score).toBeNull();

    expect(() =>
      parseJsonl(
        '{"id":"a","chunkScores":[0.3],"rerankerModel":"m","kbVersion":"v","domain":"d"}\n',
        "test.jsonl",
      ),
    ).toThrow(/test\.jsonl:1/);
    expect(() => parseJsonl("{oops}\n", "test.jsonl")).toThrow(/不是合法 JSON/);
  });

  it("profile 文件名可反推前提，且不带路径非法字符", () => {
    const name = profileFileName(profileOf({ domain: "商品咨询 / 售后退款" }));
    expect(name).toMatch(/\.json$/);
    expect(name).not.toMatch(/[\\/:*?"<>|\s]/);
  });
});

describe("闸门参数级标定（不只标一个阈值）", () => {
  const RERANK = "Qwen3-Reranker-8B";
  const KB = "kb-2026-03";
  const DOMAIN = "商品咨询";
  const KEY = `${RERANK}__${KB}__${DOMAIN}`;

  /** 群像式正类：一簇低分挤在一起，谁都领先不了 */
  const POSITIVE_CHUNKS = [0.36, 0.34, 0.33, 0.33, 0.32];
  /** 真命中负类：一条强命中 + 噪声 */
  const NEGATIVE_CHUNKS = [0.9, 0.88, 0.85, 0.4, 0.2];

  /**
   * 用采集契约构造记录——顺带验证 score 与 chunkScores 出自同一个 policy。
   * 不手拼 score，否则标定时"分布"与"合成分数"会对不上。
   */
  const makeRecords = (): CalibrationRecord[] => {
    const rows: CalibrationRecord[] = [];
    for (let i = 0; i < 120; i += 1) {
      rows.push(
        buildCalibrationRecord({
          id: `p${i}`,
          chunkScores: POSITIVE_CHUNKS,
          shouldEscalate: true,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    for (let i = 0; i < 120; i += 1) {
      rows.push(
        buildCalibrationRecord({
          id: `n${i}`,
          chunkScores: NEGATIVE_CHUNKS,
          shouldEscalate: false,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    return rows;
  };

  const OPTIONS = {
    mode: "recall_floor" as const,
    targetRecall: 0.9,
    minPrecision: 0.9,
    maxFpr: 0.3,
    minSample: 200,
    minPositives: 50,
    minNegatives: 50,
    force: false,
  };

  it("采集契约保证 score 与 chunkScores 出自同一 policy", () => {
    const record = buildCalibrationRecord({
      id: "x",
      chunkScores: NEGATIVE_CHUNKS,
      shouldEscalate: false,
      rerankerModel: RERANK,
      kbVersion: KB,
      domain: DOMAIN,
    });
    // 强领头（top 0.9 ≥ 默认 solid 0.55）→ 不做折扣，合成分数就是 top
    expect(record.score).toBeCloseTo(0.9, 4);
    expect(record.chunkScores).toEqual(NEGATIVE_CHUNKS);
  });

  it("chooseSolid 从数据里给出实心线：过线样本里'仍应转人工'的比例低于容忍度", () => {
    const cases: LabeledCaseWithChunks[] = [
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `p${i}`, score: 0.2, shouldEscalate: true, chunkScores: POSITIVE_CHUNKS,
      })),
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `n${i}`, score: 0.9, shouldEscalate: false, chunkScores: NEGATIVE_CHUNKS,
      })),
    ];
    const choice = chooseSolid(cases, { tolerance: 0.05, minSupport: 20 });
    // 0.36 以下还混着正类（50% 应转人工），必须一路推到 0.9
    expect(choice.solid).toBeCloseTo(0.9, 4);
    expect(choice.supportingCases).toBe(120);
    expect(choice.escalationRateAboveSolid).toBe(0);
  });

  it("证据不足时 chooseSolid 返回 null，而不是给一条由一两个样本撑起来的线", () => {
    const cases: LabeledCaseWithChunks[] = [
      { id: "a", score: 0.9, shouldEscalate: false, chunkScores: [0.9, 0.8] },
      { id: "b", score: 0.2, shouldEscalate: true, chunkScores: [0.2, 0.1] },
    ];
    const choice = chooseSolid(cases, { tolerance: 0.05, minSupport: 20 });
    expect(choice.solid).toBeNull();
    expect(choice.reason).toContain("不予标定");
  });

  it("gateConfusion 用注入的真实闸门函数，并统计群像触发数", () => {
    const cases: LabeledCaseWithChunks[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `p${i}`, score: 0.2, shouldEscalate: true, chunkScores: POSITIVE_CHUNKS,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `n${i}`, score: 0.9, shouldEscalate: false, chunkScores: NEGATIVE_CHUNKS,
      })),
    ];
    const confusion = gateConfusion(cases, DEFAULT_CONFIDENCE_POLICY, createGateEvaluator(), {
      maxFpr: 0.3,
    });
    expect(confusion.tp).toBe(3);
    expect(confusion.fp).toBe(0);
    expect(confusion.tpr).toBe(1);
    expect(confusion.fpr).toBe(0);
    expect(confusion.feasible).toBe(true);
    // 三条群像正类被识别出来
    expect(confusion.flockCount).toBe(3);
  });

  it("refinePolicy 不会把可行性改差，且结果确定可复现", () => {
    const cases: LabeledCaseWithChunks[] = makeRecords().map((record) => ({
      id: record.id,
      // score 可缺省，缺省时用 topScore 兜底（标定本身只看 chunkScores）
      score: record.score ?? Math.max(...record.chunkScores),
      shouldEscalate: record.shouldEscalate,
      chunkScores: record.chunkScores,
    }));
    const evaluator = createGateEvaluator();
    const initial = { ...DEFAULT_CONFIDENCE_POLICY, floor: 0.35, solid: 0.55 };
    const before = gateConfusion(cases, initial, evaluator, { maxFpr: 0.3 });
    const first = refinePolicy(cases, evaluator, initial, defaultPolicyGrid(cases), { maxFpr: 0.3 });
    const second = refinePolicy(cases, evaluator, initial, defaultPolicyGrid(cases), { maxFpr: 0.3 });

    // 贪心不保证全局最优，但绝不能把已经可行的解弄成不可行
    if (before.feasible) expect(first.confusion.feasible).toBe(true);
    expect(first.confusion.tpr).toBeGreaterThanOrEqual(before.tpr);
    // 确定性：同输入同输出（标定要能回放）
    expect(first.policy).toEqual(second.policy);
    expect(first.moves.map((m) => m.to)).toEqual(second.moves.map((m) => m.to));
    expect(first.evaluations).toBeGreaterThan(1);
  });

  it("有两支重叠时形成真实中间地带：靠区分度拦群像、靠旁证放行真支撑", () => {
    // 这份数据的关键在于**两支的 topScore 有重叠区**（0.50~0.60），于是 floor 与 solid
    // 之间真的存在一个中间地带。中间地带里：
    //   - 正类是一簇挤在一起的低分（区分度 0.33）→ 必须拦下；
    //   - 负类是三段落差明显的分（区分度 1）→ 必须放行。
    // 这正是「coverage + 区分度」这套判据存在的意义，也是"全参数标定"相对"只标 floor"的差别。
    const rows: CalibrationRecord[] = [];
    for (let i = 0; i < 120; i += 1) {
      const top = 0.4 + (i % 21) * 0.01;
      rows.push(
        buildCalibrationRecord({
          id: `overlap-p${i}`,
          chunkScores: [top, top - 0.03, top - 0.04, top - 0.04, top - 0.05],
          shouldEscalate: true,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    for (let i = 0; i < 120; i += 1) {
      const top = 0.5 + (i % 21) * 0.01;
      rows.push(
        buildCalibrationRecord({
          id: `overlap-n${i}`,
          chunkScores: [top, top - 0.02, top - 0.04, 0.05, 0.02],
          shouldEscalate: false,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }

    const result = calibrateGroup(KEY, rows, OPTIONS);
    const profile = result.profile;
    expect(result.skipped).toBe(false);
    expect(profile).toBeDefined();
    if (!profile || !result.confusion) return;

    // 真实的中间地带：floor 严格低于 solid
    expect(profile.floor).toBeLessThan(profile.solid);
    const tops = rows.map((row) => Math.max(...row.chunkScores));
    expect(profile.solid).toBeLessThanOrEqual(Math.max(...tops));
    expect(profile.floor).toBeGreaterThanOrEqual(Math.min(...tops));
    // 约束被满足，且召回没被牺牲
    expect(result.confusion.tpr).toBe(1);
    expect(result.confusion.fpr).toBeLessThanOrEqual(0.3);
    expect(result.confusion.feasible).toBe(true);
    // 群像触发率第一次有了统计口径
    expect(result.confusion.flockCount).toBeGreaterThan(0);
    expect(result.notes.join("\n")).toContain("群像式幻觉");
    // 这份数据里有中间地带，所以不该出现"塌缩"提示
    expect(result.notes.join("\n")).not.toContain("没有\"中间地带\"");
    expect(result.auc).toBeGreaterThan(0.9);
  });

  it("没有 chunkScores 的记录被 schema 拒绝：分布是标定的硬前提", () => {
    // 早期版本在缺分布时"降级只标 floor"，但 floor 也作用在 rerank 分数尺度上，
    // 只有合成分数是标不出来的——那会产出一个尺度错位的阈值。所以现在直接拒绝。
    expect(() =>
      parseJsonl(
        '{"id":"a","score":0.4,"shouldEscalate":true,"rerankerModel":"m","kbVersion":"v","domain":"d"}\n',
        "test.jsonl",
      ),
    ).toThrow(/chunkScores/);

    // 空数组同样拒绝
    expect(() =>
      parseJsonl(
        '{"id":"a","chunkScores":[],"score":0.4,"shouldEscalate":true,"rerankerModel":"m","kbVersion":"v","domain":"d"}\n',
        "test.jsonl",
      ),
    ).toThrow(/chunkScores/);
  });
});

describe("泛化验证与标定稳健性", () => {
  const RERANK = "Qwen3-Reranker-8B";
  const KB = "kb-2026-03";
  const DOMAIN = "商品咨询";
  const KEY = `${RERANK}__${KB}__${DOMAIN}`;
  const OPTIONS = {
    mode: "recall_floor" as const,
    targetRecall: 0.9,
    minPrecision: 0.9,
    maxFpr: 0.3,
    minSample: 200,
    minPositives: 50,
    minNegatives: 50,
    force: false,
  };

  const records = (): CalibrationRecord[] => {
    const rows: CalibrationRecord[] = [];
    for (let i = 0; i < 120; i += 1) {
      const top = 0.3 + (i % 7) * 0.01;
      rows.push(
        buildCalibrationRecord({
          id: `gen-p${i}`,
          chunkScores: [top, top - 0.02, top - 0.03, top - 0.03, top - 0.04],
          shouldEscalate: true,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    for (let i = 0; i < 120; i += 1) {
      const top = 0.7 + (i % 21) * 0.01;
      rows.push(
        buildCalibrationRecord({
          id: `gen-n${i}`,
          chunkScores: [top, top - 0.02, top - 0.04, 0.05, 0.02],
          shouldEscalate: false,
          rerankerModel: RERANK,
          kbVersion: KB,
          domain: DOMAIN,
        }),
      );
    }
    return rows;
  };

  it("切分是确定性的：同输入同结果，且与输入顺序无关", () => {
    const rows = records();
    const first = splitCases(rows, { validationShare: 0.3 });
    const second = splitCases(rows, { validationShare: 0.3 });
    const shuffled = splitCases([...rows].reverse(), { validationShare: 0.3 });

    expect(first.validation.map((r) => r.id)).toEqual(second.validation.map((r) => r.id));
    // 打乱输入顺序不能改变归属（否则"可复现"是假的）
    expect(shuffled.validation.map((r) => r.id).sort()).toEqual(
      first.validation.map((r) => r.id).sort(),
    );
  });

  it("切分不重不漏，比例精确", () => {
    const rows = records();
    const split = splitCases(rows, { validationShare: 0.3 });
    expect(split.validation.length + split.calibration.length).toBe(rows.length);
    const overlap = split.validation.filter((row) =>
      split.calibration.some((fit) => fit.id === row.id),
    );
    expect(overlap).toEqual([]);
    expect(split.validation.length).toBe(72); // 240 × 0.3，精确
    expect(split.validationShare).toBeCloseTo(0.3, 4);
  });

  it("样本少到无法切分时不硬切，全部留作标定集", () => {
    const split = splitCases([{ id: "only" }], { validationShare: 0.3 });
    expect(split.validation).toEqual([]);
    expect(split.calibration.length).toBe(1);
    expect(split.validationShare).toBe(0);
  });

  it("候选网格从观测分布派生：候选值必须是观测到的取值，且含当前生效值", () => {
    const cases = records().map((row) => ({
      id: row.id,
      score: row.score ?? 0,
      shouldEscalate: row.shouldEscalate,
      chunkScores: row.chunkScores,
    }));
    const initial = { ...DEFAULT_CONFIDENCE_POLICY, floor: 0.35, solid: 0.55 };
    const derived = derivePolicyGrid(cases, initial, { resolution: 6 });

    const observedTops = new Set(cases.map((item) => Number(Math.max(...item.chunkScores).toFixed(4))));
    for (const value of derived.grid.floor) expect(observedTops.has(value)).toBe(true);
    for (const value of derived.grid.solid) expect(observedTops.has(value)).toBe(true);
    // 当前生效值一定在候选里 —— 这保证搜索不会比初值更差
    expect(derived.grid.floor).toContain(initial.floor);
    expect(derived.grid.minRange).toContain(initial.minRange);
    expect(derived.grid.coverageWeight).toContain(initial.coverageWeight);

    // minRange 的上界必须是观测到的最大落差（超过它区分度永远达不到 1）
    const maxSpread = Math.max(...cases.map((c) => {
      const s = [...c.chunkScores].sort((a, b) => b - a);
      return (s[0] as number) - (s[s.length - 1] as number);
    }));
    expect(Math.max(...derived.grid.minRange)).toBeCloseTo(maxSpread, 4);

    // 派生不了的参数要如实标注，不能假装是数据推出来的
    expect(derived.rationale.coverageWeight).toContain("无法派生");
    expect(derived.rationale.minRange).toContain("分位点");
  });

  it("quantileCandidates 去重排序裁剪，并保留指定值", () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5];
    const picked = quantileCandidates(values, 3, { include: [0.25], min: 0.15, max: 0.45 });
    expect(picked).toEqual([...new Set(picked)]); // 无重复
    expect([...picked].sort((a, b) => a - b)).toEqual(picked); // 有序
    expect(picked).toContain(0.25); // include 保留
    expect(picked.every((v) => v >= 0.15 && v <= 0.45)).toBe(true); // 裁剪
    expect(quantileCandidates([], 3, { include: [0.4] })).toEqual([0.4]);
  });

  it("泛化判定用训练集自身的置信区间宽度当噪声底线", () => {
    const cases = records().map((row) => ({
      id: row.id,
      score: row.score ?? 0,
      shouldEscalate: row.shouldEscalate,
      chunkScores: row.chunkScores,
    }));
    const evaluator = createGateEvaluator();
    const confusion = gateConfusion(cases, DEFAULT_CONFIDENCE_POLICY, evaluator, { maxFpr: 0.3 });

    // 一模一样的成绩 → 差距为 0，不能判过拟合
    const identical = judgeGeneralization(confusion, confusion);
    expect(identical.overfitSuspect).toBe(false);
    expect(identical.tprGap).toBe(0);

    // 留出集召回大幅下滑 → 必须判过拟合，且理由里要引用噪声底线
    const collapsed = judgeGeneralization(confusion, {
      ...confusion,
      tp: Math.floor(confusion.tp / 2),
      fn: confusion.fn + Math.ceil(confusion.tp / 2),
      tpr: confusion.tpr / 2,
    });
    expect(collapsed.overfitSuspect).toBe(true);
    expect(collapsed.tprGap).toBeGreaterThan(0);
    expect(collapsed.reasons.join("\n")).toContain("置信区间宽度");
  });

  it("敏感性报告区分平台期与刀尖", () => {
    const cases = records().map((row) => ({
      id: row.id,
      score: row.score ?? 0,
      shouldEscalate: row.shouldEscalate,
      chunkScores: row.chunkScores,
    }));
    const evaluator = createGateEvaluator();
    const initial = { ...DEFAULT_CONFIDENCE_POLICY, floor: 0.35, solid: 0.55 };
    const rows = sensitivityReport(cases, evaluator, initial, defaultPolicyGrid(cases), {
      maxFpr: 0.3,
    });
    expect(rows.length).toBeGreaterThan(0);
    // 每个参数上有且仅有一个值被标记为当前生效值
    const summary = summarizeSensitivity(rows);
    expect(summary.length).toBeGreaterThan(0);
    for (const entry of summary) {
      expect(entry.verdict.length).toBeGreaterThan(0);
      expect(entry.feasibleAlternatives).toBeLessThanOrEqual(entry.alternatives);
    }
    const fragile = summarizeSensitivity([
      { knob: "floor", value: 0.1, tpr: 0.5, fpr: 0.5, feasible: false, chosen: false },
      { knob: "floor", value: 0.2, tpr: 1, fpr: 0, feasible: true, chosen: true },
    ]);
    expect(fragile[0]?.verdict.startsWith("脆")).toBe(true);
  });

  it("流水线输出留出集成绩、泛化判定、网格出处与敏感性", () => {
    const rows = records();
    const result = calibrateGroup(KEY, rows, OPTIONS);

    expect(result.skipped).toBe(false);
    expect(result.validation).toBeDefined();
    expect(result.generalization).toBeDefined();

    // 留出集成绩必须等于"直接在留出集上重算"——不能是别的口径拼出来的
    const split = splitCases(rows, { validationShare: 0.3 });
    const holdoutCases = split.validation.map((row) => ({
      id: row.id,
      score: row.score ?? 0,
      shouldEscalate: row.shouldEscalate,
      chunkScores: row.chunkScores,
    }));
    const expected = gateConfusion(
      holdoutCases,
      result.profile as never,
      createGateEvaluator(),
      { maxFpr: 0.3, targetRecall: 0.9 },
    );
    expect(result.validation?.tp).toBe(expected.tp);
    expect(result.validation?.fp).toBe(expected.fp);
    expect(result.validation?.sampleSize).toBe(holdoutCases.length);

    // profile 里同时留下标定集与留出集，读的人不会把被抬高的成绩当上线预期
    expect(result.profile?.metrics.tpr).toBe(result.confusion?.tpr);
    expect(result.profile?.generalization?.validationSampleSize).toBe(holdoutCases.length);
    expect(result.profile?.source).toContain("holdout=");

    // 泛化判定与判据函数一致（这里只验"有没有如实转述"，不依赖数据是否真的过拟合）
    const judge = judgeGeneralization(result.confusion as never, result.validation as never);
    expect(result.generalization?.overfitSuspect).toBe(judge.overfitSuspect);
    if (judge.overfitSuspect) {
      expect(result.skipReasons.join("\n")).toContain("过拟合");
    }

    expect(result.gridRationale?.coverageWeight).toContain("无法派生");
    expect(result.sensitivitySummary?.length).toBeGreaterThan(0);
    expect(result.notes.join("\n")).toContain("留出集");
  });

  it("留出集过小：不硬给泛化结论，并明确提示成绩只反映标定集", () => {
    const rows = records();
    const result = calibrateGroup(KEY, rows, { ...OPTIONS, validationShare: 0.02 });
    expect(result.skipped).toBe(false);
    expect(result.validation).toBeDefined();
    // 5 条留出集 < 20 条门槛 → 不给泛化判定
    expect(result.generalization).toBeUndefined();
    expect(result.profile?.generalization).toBeNull();
    expect(result.notes.join("\n")).toContain("无法可靠测量");
  });
});

describe("分布漂移", () => {
  it("PSI 能区分「同分布」与「整体位移」，空输入返回 null", () => {
    const baseline = separableCases();
    const same = separableCases();
    const shifted = [...baseline, ...baseline].map((c) =>
      caseOf(c.id, Math.min(1, c.score + 0.25), c.shouldEscalate),
    );

    const stable = populationStabilityIndex(baseline, same);
    const drifted = populationStabilityIndex(baseline, shifted);
    expect(stable).not.toBeNull();
    expect(stable as number).toBeLessThan(0.1);
    expect(drifted).not.toBeNull();
    expect(drifted as number).toBeGreaterThan(0.25);

    expect(populationStabilityIndex([], baseline)).toBeNull();
    expect(populationStabilityIndex(baseline, [])).toBeNull();
  });

  it("分数分布摘要给出中位数与 p95，便于与上版标定对比", () => {
    const distribution = scoreDistribution(separableCases());
    expect(distribution?.count).toBe(200);
    expect(distribution?.min).toBeCloseTo(0.05, 4);
    expect(distribution?.max).toBeCloseTo(0.949, 4);
    expect(distribution?.median).toBeGreaterThan(0.05);
    expect(distribution?.median).toBeLessThan(0.949);
    expect(scoreDistribution([])).toBeNull();
  });
});
