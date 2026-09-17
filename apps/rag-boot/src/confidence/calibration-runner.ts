/**
 * 标定流水线的纯逻辑：JSONL 解析 → 分组 → 分阶段标定 → 产出 profile。
 *
 * 刻意与 `scripts/calibrate-threshold.ts` 分开：
 * - 这里是可被单测覆盖的纯函数（I/O 全部由调用方传入）；
 * - 脚本那边只剩参数解析、读写文件、打印。
 *
 * 分开的理由不是洁癖：标定错的代价是线上静默变差（兜底率悄悄偏移、幻觉率上升），
 * 这种逻辑必须能被测试直接喂构造数据打靶，而不是靠"跑一次看看输出像不像"。
 *
 * ── 标定分三步，而不是只标一个阈值 ──────────────────────────────
 *
 * 1. **floor（下限）**：`chooseFloor` —— 低于它"其实答得出来"的比例低于容忍度。
 * 2. **solid（实心线）**：`chooseSolid` —— 高于它"仍需转人工"的比例低于容忍度。
 * 3. **坐标下降**：把真实闸门函数当黑盒，联合优化全部闸门参数
 *    （floor / solid / minRange / minSupportShare / flockDiscriminationMax / coverageWeight），
 *    业务约束（召回下限 + 误伤上限）作为可行性判据。
 *
 * ⚠️ **尺度**：floor 与 solid 都作用于 **rerank 原始分数（topScore）**，因为
 * `computeConfidence` 里拿它们比的就是 topScore。`chooseThreshold` 出的是
 * **合成分数尺度**的阈值，只能当"如果只有一个标量分数"的对照口径，不能当 floor——
 * 两个尺度量级不同（合成分数是 topScore 的折扣值），混用会让 floor 跑到所有
 * topScore 之上，中间地带与群像判据整段失效（有专门的测试守这条）。
 *
 * ⚠️ **数据前提**：`chunkScores`（整条召回分数分布）是标定的硬前提。
 * 闸门判决依赖 top / min / 过线条数这些分布特征，只给一个合成分数标不出来。
 * 所以 schema 直接拒绝没有 `chunkScores` 的记录——宁可让人补数据，
 * 也不要产出一个尺度错位的阈值。
 */
import { z } from "zod/v4";
import {
  auc,
  canCalibrate,
  chooseFloor,
  chooseSolid,
  chooseThreshold,
  derivePolicyGrid,
  gateConfusion,
  refinePolicy,
  populationStabilityIndex,
  scoreDistribution,
  sensitivityReport,
  splitCases,
  summarizeSensitivity,
  judgeGeneralization,
  type GateConfusion,
  type GateEvaluator,
  type GeneralizationJudge,
  type LabeledCase,
  type LabeledCaseWithChunks,
  type OperatingPoint,
  type OperatingPointMode,
  type RefineOutcome,
} from "./calibration";
import {
  CalibrationProvenanceSchema,
  ConfidenceProfileSchema,
  DEFAULT_CONFIDENCE_POLICY,
  type CalibrationProvenance,
  type ConfidencePolicy,
  type ConfidenceProfile,
} from "./profile";
import { computeConfidence } from "../nodes/confidence";
import type { RerankedChunk } from "../schema";

export const CalibrationRecordSchema = z.object({
  /** 稳定业务 id，便于把人工复核结论回溯到具体 case */
  id: z.string().min(1),
  /**
   * 该次召回的 chunk 分数分布（rerank 尺度）。**标定的硬前提**：
   * 闸门参数依赖分数分布特征，只有合成分数无从标定。
   */
  chunkScores: z
    .array(z.number().min(0).max(1))
    .min(
      1,
      "chunkScores 至少要有 1 个分数：闸门参数作用在 rerank 分数尺度上，只有合成分数无法标定",
    ),
  /** 当时链路实际算出的合成分数。选填，缺省时按同一 policy 重算 */
  score: z.number().min(0).max(1).nullable().default(null),
  /** 真实结论：这条确实答不了 / 确实转人工或被用户否定 */
  shouldEscalate: z.boolean(),
  /** 标定时的 reranker 模型名 */
  rerankerModel: z.string().min(1),
  /** 标定时的知识库版本 */
  kbVersion: z.string().min(1),
  /** 业务域 */
  domain: z.string().min(1),
  /**
   * 标签出处。
   *
   * 默认 `measured` 是为兼容既有的真实接管数据文件（它们没有这个字段），
   * **不是**给构造数据留的后门：构造数据由生成器**强制显式写入** `constructed`，
   * 且一个组里只要混入一条 constructed，整组的 provenance 就降级为 constructed（见 resolveProvenance）。
   * 这样"把少量构造数据掺进真实数据里洗成实测标定"这条路被堵住。
   */
  provenance: CalibrationProvenanceSchema.default("measured"),
  /** 构造数据可追溯：该记录属于哪个地层（answerable / near_miss / out_of_scope） */
  stratum: z.string().optional(),
});
export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

/**
 * 判定一组记录的整体出处：**取最弱的一档**。
 *
 * 只要掺了一条构造标签，整组就不能算实测标定——因为阈值是整组数据一起定出来的，
 * 无法把构造样本的贡献"局部隔离"。宁可把整组降级，也不能让一个混合组冒充实测。
 */
export function resolveProvenance(
  records: CalibrationRecord[],
): { provenance: CalibrationProvenance; constructedCount: number; measuredCount: number; note: string } {
  const constructedCount = records.filter((r) => r.provenance === "constructed").length;
  const measuredCount = records.filter((r) => r.provenance === "measured").length;
  const noneCount = records.filter((r) => r.provenance === "none").length;

  if (constructedCount > 0 && measuredCount > 0) {
    return {
      provenance: "constructed",
      constructedCount,
      measuredCount,
      note:
        `该组混入了 ${constructedCount} 条构造标签（真实标签 ${measuredCount} 条）——` +
        `整组按 constructed 处理。阈值是整组一起定出来的，无法把构造样本的影响局部隔离，` +
        `所以不允许混合组冒充实测标定。`,
    };
  }
  if (constructedCount > 0) {
    return {
      provenance: "constructed",
      constructedCount,
      measuredCount,
      note: `该组全部为构造标签（${constructedCount} 条），产出 provisional 先验，不得当作实测标定上线`,
    };
  }
  if (measuredCount === 0 && noneCount > 0) {
    return {
      provenance: "none",
      constructedCount,
      measuredCount,
      note: `该组 ${noneCount} 条记录的 provenance 为 none（未声明标签出处），按未标定处理`,
    };
  }
  return {
    provenance: "measured",
    constructedCount,
    measuredCount,
    note: `该组全部为实测标签（${measuredCount} 条）`,
  };
}

export interface CalibrateOptions {
  mode: OperatingPointMode;
  targetRecall: number;
  minPrecision: number;
  maxFpr: number;
  minSample: number;
  minPositives: number;
  minNegatives: number;
  /** 显式越过样本量门槛。越过即承认阈值不可信，由调用方负责 */
  force: boolean;
  /** floor 标定的容忍度：低于该线的样本里"其实答得出来"的比例上限 */
  floorTolerance?: number;
  /** floor 标定的最小支撑样本量 */
  floorMinSupport?: number;
  /** solid 标定的容忍度：高于该线的样本里"仍需转人工"的比例上限 */
  solidTolerance?: number;
  /** solid 标定的最小支撑样本量 */
  solidMinSupport?: number;
  /** 坐标下降轮数 */
  refinePasses?: number;
  /** 留出验证集比例（按 id hash 确定性切分）。0 表示不切分，此时无法判断过拟合 */
  validationShare?: number;
  /** 派生候选网格时的分位点数量 */
  gridResolution?: number;
  /** 是否输出敏感性报告（判断每个参数落在平台期还是刀尖上） */
  sensitivity?: boolean;
  /** 留出集小于它就不做泛化判定（样本太少，差距全在噪声里） */
  minHoldoutSample?: number;
}

export interface CalibrateGroupResult {
  key: string;
  profile?: ConfidenceProfile;
  skipped: boolean;
  skipReasons: string[];
  /** 需要让人看见、但不阻断产出的说明（例如某个参数没标成） */
  notes: string[];
  /** 合成分数尺度上的单阈值对照口径（不是 floor 的来源，见文件头注释） */
  scalarBaseline?: OperatingPoint;
  /** **标定集**上的混淆矩阵（成绩会被选择偏差抬高，别当成泛化成绩看） */
  confusion?: GateConfusion;
  /** **留出集**上的混淆矩阵：这才是对上线表现的近似无偏估计 */
  validation?: GateConfusion;
  generalization?: GeneralizationJudge;
  gridRationale?: Record<string, string>;
  sensitivitySummary?: ReturnType<typeof summarizeSensitivity>;
  auc: number | null;
  psi: number | null;
  distribution: ReturnType<typeof scoreDistribution>;
  refine?: RefineOutcome;
  /** 该组标签的整体出处（取最弱一档）。决定 profile 是 calibrated 还是 provisional */
  provenance?: CalibrationProvenance;
  /** 出处的说明，含混合组降级等数据卫生提示 */
  provenanceNote?: string;
}

export function parseJsonl(raw: string, sourceLabel: string): CalibrationRecord[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${sourceLabel}:${index + 1} 不是合法 JSON：${String(error)}`);
    }
    const result = CalibrationRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${sourceLabel}:${index + 1} 字段不合法：${JSON.stringify(result.error.issues)}`,
      );
    }
    return result.data;
  });
}

export function groupKeyOf(record: CalibrationRecord): string {
  return `${record.rerankerModel}__${record.kbVersion}__${record.domain}`;
}

/** 按前提三元组分组——阈值只在同一前提下可迁移，跨组借用就是问题一的成因 */
export function groupByKey(records: CalibrationRecord[]): Map<string, CalibrationRecord[]> {
  const groups = new Map<string, CalibrationRecord[]>();
  for (const record of records) {
    const key = groupKeyOf(record);
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

export function toLabeledCaseWithChunks(record: CalibrationRecord): LabeledCaseWithChunks {
  return {
    id: record.id,
    score: record.score ?? Number(Math.max(...record.chunkScores).toFixed(4)),
    shouldEscalate: record.shouldEscalate,
    chunkScores: record.chunkScores,
  };
}

/** topScore 尺度的单分点表征——PSI 就用在闸门真正看的那个量上 */
const toTopScoreCase = (record: CalibrationRecord): LabeledCase => ({
  id: record.id,
  score: Number(Math.max(...record.chunkScores).toFixed(4)),
  shouldEscalate: record.shouldEscalate,
});

function toChunks(chunkScores: number[], namespace = "calibration"): RerankedChunk[] {
  return chunkScores.map((value, index) => ({
    id: `${namespace}-${index}`,
    documentId: `${namespace}-doc-${index}`,
    tenantId: namespace,
    content: "",
    score: value,
    rerankScore: value,
    metadata: {},
  }));
}

/**
 * 把真实闸门函数包成标定用的评估器。
 *
 * 关键点：标定评估的就是 `computeConfidence` 本身，不是它的简化代理。
 * 自己再实现一遍判决逻辑会和生产实现漂移，标出来的参数就不代表线上行为。
 */
export function createGateEvaluator(): GateEvaluator {
  return (chunkScores, policy) => {
    const result = computeConfidence(toChunks(chunkScores), { policy });
    return {
      lowConfidence: result.lowConfidence,
      flockHallucination: result.flockHallucination,
      score: result.score,
    };
  };
}

/**
 * 采集契约：从一轮会话的落盘信息构造一条标定记录。
 *
 * 线上应当用这个函数写盘，而不是手拼 JSON——它保证 `score` 与 `chunkScores` 出自
 * 同一个 policy。否则标定时"分数分布"与"合成分数"对不上，标出来的参数是错的。
 */
export function buildCalibrationRecord(
  input: {
    id: string;
    chunkScores: number[];
    shouldEscalate: boolean;
    rerankerModel: string;
    kbVersion: string;
    domain: string;
  },
  policy?: Partial<ConfidencePolicy>,
): CalibrationRecord {
  const { score } = computeConfidence(toChunks(input.chunkScores, "record"), { policy });
  return CalibrationRecordSchema.parse({ ...input, score });
}

/**
 * 对一组 case 做分阶段标定并产出 profile。
 *
 * 不做的事（都有对应测试）：
 * - 样本不足时默认拒绝出阈值，除非显式 force
 * - 业务约束没被满足时不假装达标，而是把原因写进 notes / skipReasons
 * - floor 与 solid 标不出来时如实说"沿用保守值"，不拿外推值冒充标定产物
 */
export function calibrateGroup(
  key: string,
  records: CalibrationRecord[],
  options: CalibrateOptions,
  baseline?: CalibrationRecord[],
  now: () => Date = () => new Date(),
): CalibrateGroupResult {
  const withChunks = records.map(toLabeledCaseWithChunks);
  const topScoreCases = records.map(toTopScoreCase);
  const evaluator = createGateEvaluator();
  const objective = { maxFpr: options.maxFpr, targetRecall: options.targetRecall };
  const gate = canCalibrate(withChunks, {
    minSample: options.minSample,
    minPositives: options.minPositives,
    minNegatives: options.minNegatives,
  });
  const [rerankerModel, kbVersion, domain] = key.split("__") as [string, string, string];
  const psi = baseline
    ? populationStabilityIndex(baseline.map(toTopScoreCase), topScoreCases)
    : null;
  const distribution = scoreDistribution(topScoreCases);
  const notes: string[] = [];
  const skipReasons: string[] = [];

  if (!gate.ok && !options.force) {
    return {
      key,
      skipped: true,
      skipReasons: [
        ...gate.reasons,
        "样本不足时阈值的差异会落在抽样噪声里，已跳过。补齐样本后重跑，或用 --force 显式越过（越过即承认该阈值不可信）。",
      ],
      notes,
      auc: null,
      psi,
      distribution,
    };
  }

  // ── 步骤 0：确定性切分。所有拟合只用标定集，验证集全程不参与选择 ──────
  const split = splitCases(records, { validationShare: options.validationShare ?? 0.3 });
  const fitCases = split.calibration.map(toLabeledCaseWithChunks);
  const holdoutCases = split.validation.map(toLabeledCaseWithChunks);
  const minHoldout = options.minHoldoutSample ?? 20;
  notes.push(
    `切分：标定集 ${fitCases.length} / 留出集 ${holdoutCases.length}（按 id hash 确定性切分，可复现）`,
  );
  if (holdoutCases.length < minHoldout) {
    notes.push(
      `留出集只有 ${holdoutCases.length} 条（< ${minHoldout}）：**泛化差距无法可靠测量**，` +
        "本次产出的成绩只反映标定集，别当成上线预期",
    );
  }

  // ── 步骤 1/2：floor 与 solid 分别从数据的下沿/上沿取边界 ──────────
  let policy: ConfidencePolicy = { ...DEFAULT_CONFIDENCE_POLICY };

  const floorChoice = chooseFloor(fitCases, {
    tolerance: options.floorTolerance ?? 0.05,
    minSupport: options.floorMinSupport ?? 20,
  });
  if (floorChoice.floor !== null) {
    policy = { ...policy, floor: floorChoice.floor };
    notes.push(`floor 标定：${floorChoice.reason}`);
  } else {
    notes.push(`floor 未标定（沿用默认 ${policy.floor}）：${floorChoice.reason}`);
  }

  const solidChoice = chooseSolid(fitCases, {
    tolerance: options.solidTolerance ?? 0.05,
    minSupport: options.solidMinSupport ?? 20,
    // solid 必须高于 floor，否则两根闸门会交叉、区间概念失效
    minScore: policy.floor,
  });
  if (solidChoice.solid !== null) {
    policy = { ...policy, solid: solidChoice.solid };
    notes.push(`solid 标定：${solidChoice.reason}`);
    if (solidChoice.solid <= policy.floor) {
      notes.push(
        `floor 与 solid 重合（都是 ${policy.floor}）：这份数据里没有"中间地带"，` +
          "闸门实际退化为单阈值判决——两支样本的 topScore 完全分开了，属正常结果，但意味着覆盖度/区分度判据没被用到",
      );
    }
  } else {
    notes.push(`solid 未标定（沿用默认 ${policy.solid}）：${solidChoice.reason}`);
  }

  // 不变量：两根闸门不能交叉。相等是允许的（= 中间地带塌缩，见上面的 note），
  // 但 solid < floor 一定自相矛盾——标定失败回落默认值时会出现，这里显式修正并说明。
  if (policy.solid < policy.floor) {
    notes.push(
      `solid(${policy.solid}) 低于 floor(${policy.floor})，已抬到 floor 以保证两根闸门不交叉`,
    );
    policy = { ...policy, solid: policy.floor };
  }

  // ── 步骤 3：坐标下降联合优化，业务约束作为可行性判据 ────────────
  // 候选网格从观测分布派生（而不是拍上下界），并把当前值纳入候选，
  // 保证搜索不会比初值更差。
  const derived = derivePolicyGrid(fitCases, policy, {
    resolution: options.gridResolution ?? 6,
  });
  const refine = refinePolicy(fitCases, evaluator, policy, derived.grid, {
    ...objective,
    passes: options.refinePasses ?? 2,
  });
  policy = refine.policy;
  const confusion = refine.confusion;

  const changed = refine.moves.filter((move) => move.changed);
  if (changed.length > 0) {
    notes.push(
      `坐标下降调整了 ${changed.length} 个参数：` +
        changed.map((move) => `${move.knob} ${move.from} → ${move.to}`).join("；"),
    );
  }
  if (confusion.flockCount > 0) {
    notes.push(
      `标定集上有 ${confusion.flockCount}/${confusion.sampleSize} 条被判为群像式幻觉` +
        `（${((confusion.flockCount / confusion.sampleSize) * 100).toFixed(1)}%）——` +
        "这就是群像触发率的统计口径，线上按同样方式聚合即可",
    );
  }
  if (!confusion.feasible) {
    skipReasons.push(
      `没有任何参数组合同时满足业务约束（召回 ≥ ${(objective.targetRecall * 100).toFixed(1)}%，` +
        `误伤 ≤ ${(objective.maxFpr * 100).toFixed(1)}%）；标定集上实际 召回 ${(confusion.tpr * 100).toFixed(1)}% / ` +
        `误伤 ${(confusion.fpr * 100).toFixed(1)}%。不要直接上线：要么补样本，要么放宽约束。`,
    );
  }

  // ── 步骤 4：样本外验证。这一步才决定"网格能不能信" ──────────────
  const validation =
    holdoutCases.length > 0
      ? gateConfusion(holdoutCases, policy, evaluator, objective)
      : undefined;
  const generalization =
    validation && validation.sampleSize >= minHoldout
      ? judgeGeneralization(confusion, validation)
      : undefined;
  if (generalization) {
    if (generalization.overfitSuspect) {
      skipReasons.push(
        `留出集上的表现与标定集差距过大，判为过拟合嫌疑：${generalization.reasons.join("；")}。` +
          "不要直接上线——通常是标定集太小，或网格相对样本量过细。",
      );
    } else {
      notes.push(
        `泛化验证通过：留出集 ${validation?.sampleSize} 条上 召回 ${((validation?.tpr ?? 0) * 100).toFixed(1)}% / ` +
          `误伤 ${((validation?.fpr ?? 0) * 100).toFixed(1)}%，与标定集差距在噪声范围内`,
      );
    }
  }

  // ── 步骤 5：敏感性报告——这个选择落在平台期还是刀尖上 ─────────────
  const sensitivityEnabled = options.sensitivity ?? true;
  const sensitivitySummary = sensitivityEnabled
    ? summarizeSensitivity(
        sensitivityReport(fitCases, evaluator, policy, derived.grid, objective),
      )
    : undefined;
  if (sensitivitySummary) {
    const fragile = sensitivitySummary.filter((entry) => entry.verdict.startsWith("脆"));
    if (fragile.length > 0) {
      notes.push(
        `标定稳健性：${fragile.map((entry) => entry.knob).join("、")} 落在刀尖上（只有当前值可行）。` +
          "换一批样本很可能翻，建议样本量上来后再确认",
      );
    }
  }

  // AUC 用最终 policy 下的合成分数计算——衡量的是**部署中的判决函数**。
  // 优先用留出集算（无偏估计）；留出集不够大时才退回标定集，但那个数会被选择偏差抬高。
  const aucCases: LabeledCaseWithChunks[] =
    holdoutCases.length >= minHoldout ? holdoutCases : fitCases;
  const compositeScores: LabeledCase[] = aucCases.map((item) => ({
    id: item.id,
    score: evaluator(item.chunkScores, policy).score,
    shouldEscalate: item.shouldEscalate,
  }));
  const finalAuc = auc(compositeScores);
  // 对照口径：如果链路只输出一个标量分数，工作点会在哪里。**它不是 floor 的来源。**
  const scalarBaseline =
    chooseThreshold(compositeScores, {
      mode: options.mode,
      targetRecall: options.targetRecall,
      minPrecision: options.minPrecision,
      maxFpr: options.maxFpr,
    }) ?? undefined;

  // 标签出处决定这份产出的性质：实测 → calibrated；构造 → provisional 先验。
  // 这一步必须在 profile 构造之前，否则守卫（calibrated 蕴含 measured）会直接抛错——
  // 那正是它该做的事。
  const provenanceInfo = resolveProvenance(records);
  notes.push(`标签出处：${provenanceInfo.provenance} —— ${provenanceInfo.note}`);
  if (provenanceInfo.provenance === "constructed") {
    notes.push(
      "该 profile 是**构造数据导出的先验**（provisional），不是实测标定：" +
        "分数量纲是真的（真 embedding + 真 reranker），但「生产里哪些问题答不了、占比多少」是构造出来的。" +
        "可以拿来当过渡阈值，但它必须在拿到人工接管数据后被重新标定替换。",
    );
  }

  const profile = ConfidenceProfileSchema.parse({
    ...policy,
    profileVersion: `${rerankerModel}-${kbVersion}-${domain}-v1`,
    rerankerModel,
    kbVersion,
    domain,
    calibrated: provenanceInfo.provenance === "measured",
    provenance: provenanceInfo.provenance,
    provisional: provenanceInfo.provenance === "constructed",
    calibratedAt: now().toISOString(),
    sampleSize: topScoreCases.length,
    // metrics 是**标定集**成绩：会被选择偏差抬高。上线预期请看 generalization。
    metrics: {
      auc: finalAuc,
      tpr: Number(confusion.tpr.toFixed(4)),
      fpr: Number(confusion.fpr.toFixed(4)),
      precision: Number(confusion.precision.toFixed(4)),
    },
    generalization: generalization
      ? {
          validationSampleSize: validation?.sampleSize ?? 0,
          tpr: Number((validation?.tpr ?? 0).toFixed(4)),
          fpr: Number((validation?.fpr ?? 0).toFixed(4)),
          precision: Number((validation?.precision ?? 0).toFixed(4)),
          tprGap: generalization.tprGap,
          fprGap: generalization.fprGap,
          overfitSuspect: generalization.overfitSuspect,
          reasons: generalization.reasons,
        }
      : null,
    source:
      `n=${topScoreCases.length},fit=${fitCases.length},holdout=${holdoutCases.length},` +
      `pos=${gate.positives},neg=${gate.negatives},medianTop=${distribution?.median ?? "-"},` +
      `scale=topScore,grid=derived,flock=${confusion.flockCount}`,
  });

  return {
    key,
    profile,
    skipped: false,
    skipReasons,
    notes,
    scalarBaseline,
    confusion,
    validation,
    generalization,
    gridRationale: derived.rationale as unknown as Record<string, string>,
    sensitivitySummary,
    auc: finalAuc,
    psi,
    distribution,
    refine,
    provenance: provenanceInfo.provenance,
    provenanceNote: provenanceInfo.note,
  };
}

/** 文件名必须能反推出前提，否则 profile 多了以后没人知道哪个对应哪套环境 */
export function profileFileName(profile: ConfidenceProfile): string {
  return `${profile.rerankerModel}__${profile.kbVersion}__${profile.domain}.json`.replace(
    /[\\/:*?"<>|\s]+/g,
    "_",
  );
}
