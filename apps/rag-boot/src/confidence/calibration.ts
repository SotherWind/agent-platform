/**
 * 阈值标定：用历史人工接管的 case 做 ROC / PR，把阈值从「拍脑袋常数」变成「带样本量的测量结果」。
 *
 * 方向约定（务必先读懂，否则 TPR/FPR 会反）：
 * - 正类 = `shouldEscalate`，即「知识库确实答不了、应该转人工」。
 * - 闸门 = `fires(score, t) = score < t`，即「判为低置信」。
 * - 于是 TPR = 该转人工的里面被抓出来的比例（召回，越高越安全）；
 *   FPR = 本来能答却被误判低置信的比例（误伤，越高越扰民、越贵）。
 *
 * 这两个错误代价不对称：漏掉一个「知识库没有」的问题，等于放任模型编一个顺滑的答案
 * （用户看到的是确定性语气，代价最大）；误判一个能答的问题为低置信，代价是多一次兜底
 * 话术或一次转人工。所以工作点默认按「先保证召回下限，再压误伤」选，而不是用 Youden J
 * 那种把两类错误等权处理的准则。
 *
 * 本模块是纯函数：只吃标注数据，不碰网络、不读 .env，可被单测直接用构造数据覆盖。
 */
import type { ConfidencePolicy } from "./profile";

/**
 * 一条标注 case。score 是当时链路的置信度分数（rerank 派生），标签来自人工接管记录
 */
export interface LabeledCase {
  id: string;
  /** 0-1 的置信度分数（越低越该转人工） */
  score: number;
  /** 真实结果：true = 这条确实答不了 / 确实转人工了 */
  shouldEscalate: boolean;
  /** 数据来源标记，例如 "ticket-2026Q1"，便于追溯与分桶 */
  source?: string;
}

/**
 * 带完整召回分数分布的标注 case。
 *
 * 只标定 `floor` 时一条标量 `score` 就够；但要标定 `solid` / 区分度 / 覆盖度这些
 * 闸门参数，就必须知道当次召回的**整条分数分布**——闸门判决依赖的是 top、min、
 * 过线条数这些分布特征，而不是一个合成分数。所以线上落盘时要存 chunkScores。
 */
export interface LabeledCaseWithChunks extends LabeledCase {
  /** 该 case 召回并重排后的 chunk 分数（顺序无关，内部自行取 top/min/计数） */
  chunkScores: number[];
}

/** 从带分布的表征退化成只有合成分数的表征（用于 AUC / 单阈值口径） */
export function toScoreCase(caseWithChunks: LabeledCaseWithChunks): LabeledCase {
  return {
    id: caseWithChunks.id,
    score: caseWithChunks.score,
    shouldEscalate: caseWithChunks.shouldEscalate,
    ...(caseWithChunks.source !== undefined ? { source: caseWithChunks.source } : {}),
  };
}

export interface RocPoint {
  threshold: number;
  /** 真阳率（召回） */
  tpr: number;
  /** 假阳率（误伤） */
  fpr: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
}

export interface Interval {
  low: number;
  high: number;
}

export type OperatingPointMode = "recall_floor" | "youden" | "precision_floor";

export interface OperatingPoint extends RocPoint {
  mode: OperatingPointMode;
  /** 是否达成了调用方给的业务约束（未达成必须显式暴露，不能假装选出了一个好点） */
  metTarget: boolean;
  positives: number;
  negatives: number;
  sampleSize: number;
  /** 本次生效的误伤上限 */
  maxFpr: number;
  /** 该工作点下召回率的 Wilson 置信区间——样本越少区间越宽，直接暴露「样本够不够」 */
  recallCi: Interval;
  falsePositiveCi: Interval;
}

export interface ThresholdChoiceOptions {
  mode?: OperatingPointMode;
  /** recall_floor 模式下的召回下限，默认 0.9 */
  targetRecall?: number;
  /** precision_floor 模式下的精度下限，默认 0.9 */
  minPrecision?: number;
  /**
   * 误伤上限（FPR 天花板），默认 0.3。
   *
   * 这条约束不是可选的修辞：没有它，`recall_floor` 会退化成一个无意义的解——
   * 阈值拉到最大时"抓走全部 case"天然满足任意召回下限（TPR 恒为 1），
   * 于是算出来一个"完美达标"的工作点，代价是把所有能答的问题全转人工。
   * 有了上限，"召回 ≥ x 且误伤 ≤ y"才是一个有解也可能无解的真正约束。
   */
  maxFpr?: number;
  /** Wilson 区间置信水平，默认 0.95 */
  confidence?: number;
}

/**
 * Wilson 得分区间。
 *
 * 用 Wilson 而不是正态近似：小样本 + 极端比例（召回 100%）时正态近似会给出
 * [1, 1] 或负下界这种荒谬结果，而标定恰恰经常就是小样本。
 */
export function wilsonInterval(
  successes: number,
  total: number,
  confidence = 0.95,
): Interval {
  if (total <= 0) return { low: 0, high: 1 };
  const z = zForConfidence(confidence);
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const halfWidth =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return {
    low: clamp01(center - halfWidth),
    high: clamp01(center + halfWidth),
  };
}

function zForConfidence(confidence: number): number {
  // 只支持常见几档，避免引入统计分布依赖；标定报告不需要更细。
  if (confidence >= 0.99) return 2.576;
  if (confidence >= 0.95) return 1.96;
  if (confidence >= 0.9) return 1.645;
  return 1.96;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * 扫描所有能改变判决的候选阈值。
 *
 * 因为闸门是 `score < t`，只有「落在分数取值上」的 t 才会改变判定，
 * 所以候选集取所有出现过的分数即可，再加一个上界保证「全部判低置信」这一点也被覆盖。
 * 输出按阈值升序，FPR/TPR 也随之单调（阈值越高、抓得越多）。
 */
export function sweepThresholds(cases: LabeledCase[]): RocPoint[] {
  if (cases.length === 0) return [];
  const positives = cases.filter((c) => c.shouldEscalate).length;
  const negatives = cases.length - positives;
  const candidates = Array.from(new Set(cases.map((c) => c.score))).sort((a, b) => a - b);
  const upper = Math.max(...candidates) + Number.EPSILON * 8;
  const thresholds = [...candidates, upper];

  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const c of cases) {
      const fired = c.score < threshold;
      if (c.shouldEscalate) {
        if (fired) tp += 1;
        else fn += 1;
      } else if (fired) fp += 1;
      else tn += 1;
    }
    const predictedPositive = tp + fp;
    return {
      threshold,
      tpr: positives === 0 ? 0 : tp / positives,
      fpr: negatives === 0 ? 0 : fp / negatives,
      tp,
      fp,
      fn,
      tn,
      // 没有预测为正时精度无定义；标定报告里以 1 呈现并靠 tp+fp 字段让读的人看见
      precision: predictedPositive === 0 ? 1 : tp / predictedPositive,
    };
  });
}

/** ROC 曲线点集（按 FPR 排序，便于直接画图与算 AUC） */
export function rocCurve(cases: LabeledCase[]): RocPoint[] {
  return [...sweepThresholds(cases)].sort(
    (a, b) => a.fpr - b.fpr || a.tpr - b.tpr,
  );
}

/**
 * 梯形法 AUC。
 *
 * P 或 N 为空时返回 null 而不是 0 或 0.5 —— 单类样本上 AUC 无定义，
 * 编一个数字出来才是真正的错误。
 */
export function auc(cases: LabeledCase[]): number | null {
  const positives = cases.filter((c) => c.shouldEscalate).length;
  const negatives = cases.length - positives;
  if (positives === 0 || negatives === 0) return null;

  const curve = rocCurve(cases);
  let area = 0;
  let previous = curve[0];
  for (let i = 1; i < curve.length; i += 1) {
    const current = curve[i];
    if (!previous || !current) continue;
    area += ((current.tpr + previous.tpr) / 2) * (current.fpr - previous.fpr);
    previous = current;
  }
  return Number(clamp01(area).toFixed(4));
}

/** PR 曲线点集（按召回降序，便于看「召回换精度」的代价） */
export function prCurve(cases: LabeledCase[]): RocPoint[] {
  return [...sweepThresholds(cases)].sort(
    (a, b) => b.tpr - a.tpr || b.precision - a.precision,
  );
}

/**
 * 选工作点。默认 `recall_floor`：满足「召回下限 + 误伤上限」的前提下，把误伤压到最小。
 *
 * 两个约束缺一不可：只给召回下限会退化成"全部转人工"，只给误伤上限会退化成"一律不转"。
 * 如果没有任何阈值能同时满足，**不静默退让**：返回在误伤上限内召回最高的点，
 * 并把 metTarget 标 false，由调用方决定是接受、还是回去补样本/调业务约束。
 */
export function chooseThreshold(
  cases: LabeledCase[],
  options: ThresholdChoiceOptions = {},
): OperatingPoint | null {
  const points = sweepThresholds(cases);
  if (points.length === 0) return null;

  const mode = options.mode ?? "recall_floor";
  const targetRecall = options.targetRecall ?? 0.9;
  const minPrecision = options.minPrecision ?? 0.9;
  const maxFpr = options.maxFpr ?? 0.3;

  const positives = cases.filter((c) => c.shouldEscalate).length;
  const negatives = cases.length - positives;

  const byLowestFpr = (a: RocPoint, b: RocPoint) =>
    a.fpr - b.fpr || b.precision - a.precision || a.threshold - b.threshold;
  const byHighestTpr = (a: RocPoint, b: RocPoint) =>
    b.tpr - a.tpr || byLowestFpr(a, b);

  const withinFprCeiling = points.filter((p) => p.fpr <= maxFpr);
  // 连误伤上限都满足不了时，退到"误伤最小的点"——它至少不是"全部转人工"
  const fallbackPool = withinFprCeiling.length > 0
    ? [...withinFprCeiling].sort(byHighestTpr)
    : [...points].sort(byLowestFpr);

  let picked: RocPoint;
  let metTarget: boolean;

  if (mode === "youden") {
    // Youden 把两类错误等权，本场景代价不对称，只作为对照口径提供
    picked = [...points].sort(
      (a, b) => b.tpr - b.fpr - (a.tpr - a.fpr) || a.threshold - b.threshold,
    )[0] as RocPoint;
    metTarget = picked.fpr <= maxFpr;
  } else if (mode === "precision_floor") {
    const eligible = points.filter((p) => p.precision >= minPrecision && p.fpr <= maxFpr);
    metTarget = eligible.length > 0;
    picked = (eligible.length > 0 ? [...eligible].sort(byHighestTpr) : fallbackPool)[0] as RocPoint;
  } else {
    const eligible = points.filter((p) => p.tpr >= targetRecall && p.fpr <= maxFpr);
    metTarget = eligible.length > 0;
    picked = (eligible.length > 0 ? [...eligible].sort(byLowestFpr) : fallbackPool)[0] as RocPoint;
  }

  const confidence = options.confidence ?? 0.95;
  return {
    ...picked,
    mode,
    metTarget,
    positives,
    negatives,
    sampleSize: cases.length,
    maxFpr,
    recallCi: wilsonInterval(picked.tp, positives, confidence),
    falsePositiveCi: wilsonInterval(picked.fp, negatives, confidence),
  };
}

/* ─────────────────── 闸门参数级标定（不只是单阈值） ───────────────────
 *
 * 只标 `floor` 是不够的：`solid` / `minRange` / `minSupportShare` /
 * `flockDiscriminationMax` / `coverageWeight` 同样决定判决结果，把它们留成经验值
 * 等于把"拍脑袋"从阈值搬到了参数表里。
 *
 * 这一节的做法是：把那套真实闸门函数（由调用方注入，生产里就是 computeConfidence）
 * 当成黑盒，用标注数据直接评估它、搜索参数。这样标定出来的就是**部署中的判决函数**，
 * 而不是它的某个简化代理——AUC 也跟着从"单分数阈值"升级为"合成分数的判别力"。
 */

/** 一次闸门判决的结果（只取标定需要的字段） */
export interface GateDecision {
  lowConfidence: boolean;
  flockHallucination: boolean;
  /** 合成分数，用于 AUC 与报告 */
  score: number;
}

/** 注入真实闸门函数。标定模块不自己实现判决逻辑，避免与生产实现漂移 */
export type GateEvaluator = (
  chunkScores: number[],
  policy: ConfidencePolicy,
) => GateDecision;

export interface GateConfusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  tpr: number;
  fpr: number;
  precision: number;
  positives: number;
  negatives: number;
  sampleSize: number;
  /** 是否同时满足误伤上限与召回下限。坐标下降的第一优先级判据 */
  feasible: boolean;
  maxFpr: number;
  targetRecall: number;
  /** 该 policy 下被判为群像式幻觉的条数——群像触发率的统计口径 */
  flockCount: number;
  recallCi: Interval;
  falsePositiveCi: Interval;
}

export interface GateObjective {
  /** 误伤上限（FPR 天花板），默认 0.3 */
  maxFpr?: number;
  /** 召回下限，默认 0（只受误伤约束）。给了它才构成双约束 */
  targetRecall?: number;
  /** Wilson 区间置信水平，默认 0.95 */
  confidence?: number;
}

/** 用注入的闸门函数在整组数据上算混淆矩阵 */
export function gateConfusion(
  cases: LabeledCaseWithChunks[],
  policy: ConfidencePolicy,
  evaluate: GateEvaluator,
  objective: GateObjective = {},
): GateConfusion {
  const maxFpr = objective.maxFpr ?? 0.3;
  const targetRecall = objective.targetRecall ?? 0;
  const confidence = objective.confidence ?? 0.95;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let flockCount = 0;

  for (const item of cases) {
    const decision = evaluate(item.chunkScores, policy);
    if (decision.flockHallucination) flockCount += 1;
    if (item.shouldEscalate) {
      if (decision.lowConfidence) tp += 1;
      else fn += 1;
    } else if (decision.lowConfidence) fp += 1;
    else tn += 1;
  }

  const positives = tp + fn;
  const negatives = tn + fp;
  const tpr = positives === 0 ? 0 : tp / positives;
  const fpr = negatives === 0 ? 0 : fp / negatives;
  return {
    tp,
    fp,
    fn,
    tn,
    tpr,
    fpr,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    positives,
    negatives,
    sampleSize: cases.length,
    // 两个约束缺一不可：只给召回下限会退化成"全部转人工"，
    // 只给误伤上限会退化成"一律不转"。feasible 表达的是"业务约束真被满足了"。
    feasible: fpr <= maxFpr && tpr >= targetRecall,
    maxFpr,
    targetRecall,
    flockCount,
    recallCi: wilsonInterval(tp, positives, confidence),
    falsePositiveCi: wilsonInterval(fp, negatives, confidence),
  };
}

export interface FloorChoice {
  floor: number | null;
  /** 落在 floor 以下的样本量 */
  supportingCases: number;
  /** 落在 floor 以下、却其实"答得出来"（shouldEscalate=false）的比例 */
  answerableRateBelowFloor: number | null;
  reason: string;
}

/**
 * 数据驱动地定 `floor`（下限）。
 *
 * 语义：取**最大的**那个分数 s，使得"topScore < s"的样本里、其实答得出来的比例
 * 不超过 `tolerance`。换句话说——低于这条线的分数，基本可以认定库里没有。
 *
 * ⚠️ 尺度必须和 `solid` 一致：两者都作用在 **rerank 原始分数（topScore）** 上，
 * 因为 `computeConfidence` 里 floor / solid 就是拿去和 topScore 比的。
 * 如果拿"合成分数"上的阈值当 floor，两个尺度会被混用——合成分数是 topScore 的
 * 折扣后数值（量级更小），错位之后 floor 可能跑到所有 topScore 之上，
 * 于是所有样本都走"低于下限"分支，中间地带与群像判据整段失效。
 * `chooseThreshold` 出的阈值是**合成分数尺度**，只能当对照口径，不能当 floor。
 */
export function chooseFloor(
  cases: LabeledCaseWithChunks[],
  options: { tolerance?: number; minSupport?: number } = {},
): FloorChoice {
  const tolerance = options.tolerance ?? 0.05;
  const minSupport = options.minSupport ?? 20;
  if (cases.length === 0) {
    return { floor: null, supportingCases: 0, answerableRateBelowFloor: null, reason: "没有样本" };
  }

  const tops = cases.map((item) => Math.max(...item.chunkScores));
  const candidates = [...new Set(tops)].sort((a, b) => a - b);
  const upper = (candidates[candidates.length - 1] as number) + Number.EPSILON * 8;
  let chosen: number | null = null;
  let chosenCases = 0;
  let chosenRate: number | null = null;
  let tightest = 1;
  let tightestCases = 0;

  for (const candidate of [0, ...candidates, upper]) {
    const below = cases.filter((item) => Math.max(...item.chunkScores) < candidate);
    if (below.length < minSupport) continue;
    const rate = below.filter((item) => !item.shouldEscalate).length / below.length;
    if (rate <= tolerance) {
      // 取最大的合格候选：这是"还能保证低于它就不行"的最宽边界
      if (chosen === null || candidate > chosen) {
        chosen = candidate;
        chosenCases = below.length;
        chosenRate = rate;
      }
    }
    if (rate < tightest) {
      tightest = rate;
      tightestCases = below.length;
    }
  }

  if (chosen === null) {
    return {
      floor: null,
      supportingCases: tightestCases,
      answerableRateBelowFloor: Number(tightest.toFixed(4)),
      reason: `没有任何分数点上"其实答得出来"比例降到 ${(tolerance * 100).toFixed(1)}% 以下（样本量 ≥ ${minSupport} 的前提下），floor 不予标定，请沿用保守值并补样本`,
    };
  }

  return {
    floor: Number(chosen.toFixed(4)),
    supportingCases: chosenCases,
    answerableRateBelowFloor: chosenRate === null ? null : Number(chosenRate.toFixed(4)),
    reason: `topScore < ${chosen.toFixed(4)} 的 ${chosenCases} 条中，"其实答得出来"的比例 ${((chosenRate ?? 0) * 100).toFixed(1)}% ≤ 容忍度 ${(tolerance * 100).toFixed(1)}%`,
  };
}


export interface SolidChoice {
  solid: number | null;
  /** 落在 solid 以上的样本量 */
  supportingCases: number;
  /** 落在 solid 以上、却仍然"应该转人工"的比例（越低说明这条线越可信） */
  escalationRateAboveSolid: number | null;
  reason: string;
}

/**
 * 数据驱动地定 `solid`（实心线）。
 *
 * 语义：取**最小的**那个分数 s，使得"topScore ≥ s"的样本里、真实该转人工的比例
 * 不超过 `tolerance`。换句话说——过了这条线的分数，单条命中就已经可信到可以独立支撑回答。
 *
 * 与 `floor` 的关系：`floor` 管"低于它一定不行"（召回侧），`solid` 管"高于它一定行"
 * （误伤侧）。两者是同一条决策边界的两端，所以必须都从数据里来。
 *
 * 证据不足时返回 null 而不是给一个漂亮的数字：如果只有一两条样本落在线上，
 * 那条线就是噪声。
 */
export function chooseSolid(
  cases: LabeledCaseWithChunks[],
  options: { tolerance?: number; minSupport?: number; minScore?: number } = {},
): SolidChoice {
  const tolerance = options.tolerance ?? 0.05;
  const minSupport = options.minSupport ?? 20;
  const minScore = options.minScore ?? 0;
  if (cases.length === 0) {
    return { solid: null, supportingCases: 0, escalationRateAboveSolid: null, reason: "没有样本" };
  }

  const tops = cases.map((item) => Math.max(...item.chunkScores));
  const candidates = [...new Set(tops)].filter((value) => value >= minScore).sort((a, b) => a - b);
  if (candidates.length === 0) {
    return {
      solid: null,
      supportingCases: 0,
      escalationRateAboveSolid: null,
      reason: `没有样本的 topScore ≥ floor(${minScore})，solid 不可能高于 floor，不予标定`,
    };
  }
  const upper = (candidates[candidates.length - 1] as number) + Number.EPSILON * 8;
  let bestSample = 0;
  let bestRate: number | null = null;

  for (const candidate of [...candidates, upper]) {
    const above = cases.filter((item) => Math.max(...item.chunkScores) >= candidate);
    if (above.length < minSupport) continue;
    const rate = above.filter((item) => item.shouldEscalate).length / above.length;
    // 记录"样本量最大的一次不达标"用来说明为什么拒绝给线
    if (bestRate === null || rate < bestRate) {
      bestRate = rate;
      bestSample = above.length;
    }
    if (rate <= tolerance) {
      return {
        solid: Number(candidate.toFixed(4)),
        supportingCases: above.length,
        escalationRateAboveSolid: Number(rate.toFixed(4)),
        reason: `topScore ≥ ${candidate.toFixed(4)} 的 ${above.length} 条中，应转人工比例 ${(rate * 100).toFixed(1)}% ≤ 容忍度 ${(tolerance * 100).toFixed(1)}%`,
      };
    }
  }

  return {
    solid: null,
    supportingCases: bestSample,
    escalationRateAboveSolid: bestRate === null ? null : Number(bestRate.toFixed(4)),
    reason:
      `没有任何分数点上"应转人工"比例降到 ${(tolerance * 100).toFixed(1)}% 以下` +
      `（样本量 ≥ ${minSupport}、且分数 ≥ floor ${minScore} 的前提下），solid 不予标定，请沿用保守值并补样本`,
  };
}

/** 坐标下降的候选网格。floor/solid 由观测分数派生，其余给经验区间 */
export interface PolicyGrid {
  floor: number[];
  solid: number[];
  minRange: number[];
  minSupportShare: number[];
  flockDiscriminationMax: number[];
  coverageWeight: number[];
}

/**
 * 默认网格。
 *
 * floor/solid 的候选点直接取观测到的 topScore（去重后按分位抽稀），
 * 因为只有落在实际取值上的阈值才会改变判决；抽稀是为了把网格控制在线性可跑的范围。
 */
export function defaultPolicyGrid(
  cases: LabeledCaseWithChunks[],
  options: { maxThresholdCandidates?: number } = {},
): PolicyGrid {
  const maxCandidates = options.maxThresholdCandidates ?? 24;
  const tops = [...new Set(cases.map((item) => Math.max(...item.chunkScores)))].sort(
    (a, b) => a - b,
  );
  const thin = (values: number[]): number[] => {
    if (values.length <= maxCandidates) return values;
    const step = values.length / maxCandidates;
    const picked: number[] = [];
    for (let i = 0; i < maxCandidates; i += 1) {
      picked.push(values[Math.min(values.length - 1, Math.floor(i * step))] as number);
    }
    return [...new Set(picked)];
  };
  const thresholds = tops.length === 0 ? [0.35] : thin(tops);

  return {
    floor: thresholds.map((value) => Number(value.toFixed(4))),
    solid: thresholds.map((value) => Number(value.toFixed(4))),
    minRange: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3],
    minSupportShare: [0.2, 0.34, 0.5, 0.67, 0.8],
    flockDiscriminationMax: [0.2, 0.35, 0.5, 0.65, 0.8],
    coverageWeight: [0.2, 0.3, 0.4, 0.5, 0.6],
  };
}

export interface RefineOutcome {
  policy: ConfidencePolicy;
  confusion: GateConfusion;
  /** 每个参数最终落在哪个值上、以及相对初值动了多少——报告里要说清"这次标定改了什么" */
  moves: Array<{ knob: keyof PolicyGrid; from: number; to: number; changed: boolean }>;
  evaluations: number;
}

const KNOB_ORDER: Array<keyof PolicyGrid> = [
  "floor",
  "solid",
  "minRange",
  "minSupportShare",
  "flockDiscriminationMax",
  "coverageWeight",
];

/** 判据优先级：先满足误伤上限，再拉高召回，再压误伤，最后看精度 */
function isBetter(candidate: GateConfusion, current: GateConfusion): boolean {
  if (candidate.feasible !== current.feasible) return candidate.feasible;
  if (candidate.tpr !== current.tpr) return candidate.tpr > current.tpr;
  if (candidate.fpr !== current.fpr) return candidate.fpr < current.fpr;
  return candidate.precision > current.precision;
}

/**
 * 在网格上做坐标下降，联合优化整个闸门参数组。
 *
 * 刻意说明：坐标下降是**贪心**的，不保证全局最优。选它而不选全网格搜索，是因为
 * 6 个参数的全组合会把评估次数乘到不可控，而这里真正重要的是**可解释**——
 * 报告能说清每个参数为什么落在那个值上。多跑几轮 `passes` 可以缓解贪心早停。
 */
export function refinePolicy(
  cases: LabeledCaseWithChunks[],
  evaluate: GateEvaluator,
  initial: ConfidencePolicy,
  grid: PolicyGrid,
  options: GateObjective & { passes?: number } = {},
): RefineOutcome {
  const passes = options.passes ?? 2;
  let policy: ConfidencePolicy = { ...initial };
  let confusion = gateConfusion(cases, policy, evaluate, options);
  let evaluations = 1;
  const startValues = new Map<keyof PolicyGrid, number>(
    KNOB_ORDER.map((knob) => [knob, policy[knob] as number]),
  );

  for (let pass = 0; pass < passes; pass += 1) {
    let improvedInPass = false;
    for (const knob of KNOB_ORDER) {
      const candidates = grid[knob];
      if (!candidates || candidates.length === 0) continue;
      for (const candidate of candidates) {
        if (candidate === policy[knob]) continue;
        const probe: ConfidencePolicy = { ...policy, [knob]: candidate };
        const probeConfusion = gateConfusion(cases, probe, evaluate, options);
        evaluations += 1;
        if (isBetter(probeConfusion, confusion)) {
          policy = probe;
          confusion = probeConfusion;
          improvedInPass = true;
        }
      }
    }
    if (!improvedInPass) break;
  }

  return {
    policy,
    confusion,
    moves: KNOB_ORDER.map((knob) => {
      const from = startValues.get(knob) as number;
      const to = policy[knob] as number;
      return { knob, from, to, changed: from !== to };
    }),
    evaluations,
  };
}

/* ─────────────── 候选网格：从观测分布派生，而不是拍上下界 ───────────────
 *
 * 「网格上下界是人工给的」之所以是个缺口，理由不是洁癖：如果某个参数的候选值
 * 恰好没有覆盖到真正可用区，坐标下降就会停在一个"看起来达标"的错位置上，
 * 而报告里看不出这件事（它只会说"评估了 N 次，选了 X"）。
 *
 * 能派生的就派生：可标定参数的语义都锚在观测分布上，所以候选取**分位点**——
 * 每个候选值都对应"有百分之几的样本落在它之上"，天然有解释。
 * 派生不了的如实说：`coverageWeight` 是合成分数的混合权重，不锚在任何观测特征上，
 * 它只能是一个设计选择（覆盖面铺开即可，不要假装它是数据推出来的）。
 */

/** 从一组观测值里取出等间隔分位点；always 里的值一定保留（含当前生效值） */
export function quantileCandidates(
  values: number[],
  resolution: number,
  options: { include?: number[]; min?: number; max?: number } = {},
): number[] {
  // 边界也要按同样的精度取整再比较：否则 0.9-0.02 = 0.8799999999999999 会让
  // 取整后的 0.88 判为"超过上界"而被静默丢掉——上界值恰恰是最该保留的候选之一。
  const round4 = (value: number): number => Number(value.toFixed(4));
  const lower = round4(options.min ?? 0);
  const upper = round4(options.max ?? 1);
  const include = (options.include ?? [])
    .map(round4)
    .filter((v) => v >= lower && v <= upper);
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const picked: number[] = [...include];
  if (finite.length > 0 && resolution > 0) {
    for (let i = 0; i < resolution; i += 1) {
      const q = resolution === 1 ? 0.5 : i / (resolution - 1);
      const index = Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))));
      picked.push(finite[index] as number);
    }
  }
  return [...new Set(picked.map(round4))]
    .filter((v) => v >= lower && v <= upper)
    .sort((a, b) => a - b);
}

export interface DerivedGrid {
  grid: PolicyGrid;
  /** 每个参数的候选值是怎么来的——报告里要说清，否则"派生"和"拍"看起来一样 */
  rationale: Record<keyof PolicyGrid, string>;
}

/**
 * 从观测分布派生候选网格。
 *
 * - `floor` / `solid`：候选取观测到的 topScore（只有落在实际取值上的阈值才会改变判决）。
 * - `minRange`：候选取 `top - min`（落差）的分位点。上界天然是观测到的最大落差——
 *   超过它区分度永远达不到 1，中间地带会把所有东西都拒掉。
 * - `minSupportShare`：候选取"过线条数占比"的分位点。
 * - `flockDiscriminationMax`：候选取区分度的分位点（区分度按**初始** minRange 归一后算，
 *   以打断"区分度依赖 minRange"的循环）。
 * - `coverageWeight`：无法派生。它是合成分数的混合权重，不锚在观测特征上，
 *   只能给一个固定覆盖面，并在 rationale 里标明这是设计选择。
 *
 * `initial` 的当前值一律纳入候选：保证搜索**不会比初值更差**。
 */
export function derivePolicyGrid(
  cases: LabeledCaseWithChunks[],
  initial: ConfidencePolicy,
  options: { resolution?: number } = {},
): DerivedGrid {
  const resolution = options.resolution ?? 6;
  const tops: number[] = [];
  const spreads: number[] = [];
  const coverages: number[] = [];
  const discriminations: number[] = [];
  const rangeDenominator = Math.max(initial.minRange, Number.EPSILON);

  for (const item of cases) {
    const sorted = [...item.chunkScores].sort((a, b) => b - a);
    const top = sorted[0] as number;
    const lowest = sorted[sorted.length - 1] as number;
    const spread = top - lowest;
    tops.push(top);
    spreads.push(spread);
    coverages.push(sorted.filter((s) => s >= initial.floor).length / sorted.length);
    discriminations.push(Math.min(1, Math.max(0, spread / rangeDenominator)));
  }

  const thresholdCandidates = quantileCandidates(tops, resolution);
  const maxSpread = spreads.length > 0 ? Math.max(...spreads) : 1;

  return {
    grid: {
      floor: thresholdCandidates,
      solid: thresholdCandidates,
      minRange: quantileCandidates(spreads, resolution, {
        min: 1e-4,
        max: Math.max(maxSpread, 1e-4),
        include: [initial.minRange],
      }),
      minSupportShare: quantileCandidates(coverages, resolution, {
        min: 1e-4,
        max: 1,
        include: [initial.minSupportShare],
      }),
      flockDiscriminationMax: quantileCandidates(discriminations, resolution, {
        min: 0,
        max: 1,
        include: [initial.flockDiscriminationMax],
      }),
      coverageWeight: [0.2, 0.4, 0.6, 0.8].includes(initial.coverageWeight)
        ? [0.2, 0.4, 0.6, 0.8]
        : [...new Set([0.2, 0.4, 0.6, 0.8, initial.coverageWeight])].sort((a, b) => a - b),
    },
    rationale: {
      floor: `观测 topScore 的 ${thresholdCandidates.length} 个分位点（阈值只有落在实际取值上才改变判决）`,
      solid: `同 floor 的候选集；另有 s ≥ floor 的顺序约束`,
      minRange: `观测落差 (top-min) 的分位点，上界=最大落差 ${Number(maxSpread.toFixed(4))}（超过它区分度永远达不到 1）`,
      minSupportShare: "观测「过线条数占比」的分位点",
      flockDiscriminationMax: `观测区分度的分位点（按初始 minRange=${initial.minRange} 归一）`,
      coverageWeight: "⚠️ 无法派生：它是合成分数的混合权重，不锚在观测特征上，属设计选择",
    },
  };
}

/* ─────────────── 样本外验证：网格能不能变细，取决于这个 ───────────────
 *
 * 这才是"半标定"的真正症结。把候选网格加细本身毫无技术难度，难的是**加细之后你还能不能
 * 相信选出来的值**：当相邻候选之间的指标差异小于抽样噪声时，坐标下降挑的是噪声。
 * 没有样本外验证，就无法区分"真的更好"和"在这份标注集上恰好更好"。
 *
 * 所以先解决"能不能信"，再谈"能不能更细"。
 */

export interface CaseSplit<T> {
  calibration: T[];
  validation: T[];
  /** 实际切分比例（按 hash 排序后取前 N 个，比例是精确的） */
  validationShare: number;
}

/** FNV-1a：切分要可复现，不能用 Math.random */
function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 确定性切分为标定集 / 验证集。
 *
 * 按 `hash(id)` 排序后取前 N 个进验证集——比例精确、结果可复现，且与数据规模增长无关地稳定
 * （新样本不会打乱已有归属到"互相之间"的关系，而是各自按 hash 落位）。
 */
export function splitCases<T extends { id: string }>(
  cases: T[],
  options: { validationShare?: number } = {},
): CaseSplit<T> {
  const share = Math.min(0.9, Math.max(0, options.validationShare ?? 0.3));
  const ordered = [...cases].sort((a, b) => stableHash(a.id) - stableHash(b.id) || a.id.localeCompare(b.id));
  const validationCount = Math.min(
    ordered.length - 1,
    Math.max(1, Math.round(ordered.length * share)),
  );
  if (ordered.length < 2 || validationCount <= 0) {
    return { calibration: ordered, validation: [], validationShare: 0 };
  }
  return {
    calibration: ordered.slice(validationCount),
    validation: ordered.slice(0, validationCount),
    validationShare: Number((validationCount / ordered.length).toFixed(4)),
  };
}

export interface GeneralizationJudge {
  overfitSuspect: boolean;
  reasons: string[];
  /** 训练集召回 - 验证集召回（正=验证集更差） */
  tprGap: number;
  /** 验证集误伤 - 训练集误伤（正=验证集更差） */
  fprGap: number;
}

/**
 * 判断"训练集上的好成绩"是不是过拟合。
 *
 * 判据的核心是**用训练集自身的置信区间宽度当噪声底线**：差距落在这个宽度之内，
 * 说明不了任何事（那点差异本来就在抽样误差里）；只有超出噪声底线，才算过拟合的证据。
 * 这条规则的好处是它随样本量自动收紧——样本越多，能被容忍的差距越小。
 */
export function judgeGeneralization(
  train: GateConfusion,
  validation: GateConfusion,
): GeneralizationJudge {
  const tprGap = Number((train.tpr - validation.tpr).toFixed(4));
  const fprGap = Number((validation.fpr - train.fpr).toFixed(4));
  const tprNoise = train.recallCi.high - train.recallCi.low;
  const fprNoise = train.falsePositiveCi.high - train.falsePositiveCi.low;
  const reasons: string[] = [];

  if (tprGap > tprNoise) {
    reasons.push(
      `召回在验证集上掉了 ${(tprGap * 100).toFixed(1)} 个百分点，超过训练集自身置信区间宽度 ${(tprNoise * 100).toFixed(1)}%，不是抽样噪声能解释的`,
    );
  }
  if (fprGap > fprNoise) {
    reasons.push(
      `误伤在验证集上涨了 ${(fprGap * 100).toFixed(1)} 个百分点，超过训练集自身置信区间宽度 ${(fprNoise * 100).toFixed(1)}%`,
    );
  }
  return { overfitSuspect: reasons.length > 0, reasons, tprGap, fprGap };
}

export interface SensitivityRow {
  knob: keyof PolicyGrid;
  value: number;
  tpr: number;
  fpr: number;
  feasible: boolean;
  /** true 表示该值就是当前生效值 */
  chosen: boolean;
}

/**
 * 敏感性报告：把每个参数在候选值上的表现摊开。
 *
 * 它回答的问题是"这个选择落在平台期还是刀尖上"——如果相邻候选值的结果几乎一样，
 * 说明选哪个都行（标定稳健）；如果只有当前这个值可行、隔壁就崩，那这份标定是脆的，
 * 换一批样本很可能就翻。
 */
export function sensitivityReport(
  cases: LabeledCaseWithChunks[],
  evaluate: GateEvaluator,
  policy: ConfidencePolicy,
  grid: PolicyGrid,
  objective: GateObjective = {},
): SensitivityRow[] {
  const rows: SensitivityRow[] = [];
  for (const knob of KNOB_ORDER) {
    const candidates = grid[knob];
    if (!candidates || candidates.length === 0) continue;
    for (const value of candidates) {
      const probe: ConfidencePolicy = { ...policy, [knob]: value };
      const confusion = gateConfusion(cases, probe, evaluate, objective);
      rows.push({
        knob,
        value,
        tpr: Number(confusion.tpr.toFixed(4)),
        fpr: Number(confusion.fpr.toFixed(4)),
        feasible: confusion.feasible,
        chosen: value === policy[knob],
      });
    }
  }
  return rows;
}

/** 把敏感性报告压成"这个参数稳不稳"的结论 */
export function summarizeSensitivity(
  rows: SensitivityRow[],
): Array<{ knob: keyof PolicyGrid; alternatives: number; feasibleAlternatives: number; verdict: string }> {
  return KNOB_ORDER.map((knob) => {
    const own = rows.filter((row) => row.knob === knob);
    const alternatives = own.filter((row) => !row.chosen);
    const feasibleAlternatives = alternatives.filter((row) => row.feasible).length;
    const verdict =
      feasibleAlternatives === 0
        ? "脆：只有当前值可行，换一批样本很可能翻"
        : feasibleAlternatives >= Math.max(1, Math.floor(alternatives.length / 2))
          ? "稳：多数候选值同样可行（平台期）"
          : "一般：少数邻近候选值也可行";
    return { knob, alternatives: alternatives.length, feasibleAlternatives, verdict };
  }).filter((entry) => entry.alternatives > 0);
}

export interface CalibratableCheck {  ok: boolean;
  reasons: string[];
  positives: number;
  negatives: number;
  sampleSize: number;
}

/**
 * 标定前置检查。
 *
 * 存在的意义是拦住「用 30 条 case 标出一个看起来精确的阈值」这种自欺：
 * 小样本下 Wilson 区间会宽到覆盖大半个 [0,1]，此时任何阈值差异都在噪声里。
 */
export function canCalibrate(
  cases: LabeledCase[],
  options: { minSample?: number; minPositives?: number; minNegatives?: number } = {},
): CalibratableCheck {
  const minSample = options.minSample ?? 200;
  const minPositives = options.minPositives ?? 50;
  const minNegatives = options.minNegatives ?? 50;
  const positives = cases.filter((c) => c.shouldEscalate).length;
  const negatives = cases.length - positives;
  const reasons: string[] = [];

  if (cases.length < minSample) {
    reasons.push(
      `总样本 ${cases.length} < ${minSample}：阈值差异会淹没在抽样噪声里`,
    );
  }
  if (positives < minPositives) {
    reasons.push(`正类（应转人工）${positives} < ${minPositives}`);
  }
  if (negatives < minNegatives) {
    reasons.push(`负类（可自动回答）${negatives} < ${minNegatives}`);
  }

  return { ok: reasons.length === 0, reasons, positives, negatives, sampleSize: cases.length };
}

/** 分数分布摘要：用于和上版标定对比，发现分布漂移 */
export function scoreDistribution(cases: LabeledCase[]): {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
} | null {
  if (cases.length === 0) return null;
  const sorted = [...cases.map((c) => c.score)].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] as number;
  return {
    count: sorted.length,
    min: sorted[0] as number,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] as number,
    mean: Number((sorted.reduce((sum, v) => sum + v, 0) / sorted.length).toFixed(4)),
  };
}

/**
 * 群体稳定性指标（PSI）的简化版：比较两个分数分布是否漂移。
 *
 * 换 reranker 版本、知识库从 100 篇涨到 1 万篇、query 分布从商品咨询变成投诉工单，
 * 都会先体现在分数分布上。PSI > 0.25 就该重新标定；0.1~0.25 需要人工看一眼。
 */
export function populationStabilityIndex(
  baseline: LabeledCase[],
  current: LabeledCase[],
  buckets = 10,
): number | null {
  if (baseline.length === 0 || current.length === 0) return null;
  const share = (cases: LabeledCase[]) => {
    const counts = new Array(buckets).fill(0) as number[];
    for (const c of cases) {
      const value = Math.min(1, Math.max(0, c.score));
      const index = Math.min(buckets - 1, Math.floor(value * buckets));
      counts[index] = (counts[index] ?? 0) + 1;
    }
    // 拉普拉斯平滑：避免空桶导致 log(0) 与 PSI 爆炸
    return counts.map((n) => (n + 0.5) / (cases.length + 0.5 * buckets));
  };
  const base = share(baseline);
  const next = share(current);
  const psi = base.reduce((sum, b, i) => {
    const c = next[i] as number;
    return sum + (c - b) * Math.log(c / b);
  }, 0);
  return Number(psi.toFixed(4));
}
