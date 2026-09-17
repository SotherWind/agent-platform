/**
 * 决策带分析（decision band）。
 *
 * 回答的问题是：**阈值该落在哪，以及能不能有把握地落。**
 *
 * 与 `chooseThreshold` 的区别：后者在候选阈值上扫 ROC 挑工作点，这里不做选择，
 * 只回答"可行域有多宽"。这个区别在样本是**构造**出来的时候很关键——
 * 构造数据的流行度（两类在总体中的占比）是我编的，但**类内分布**是真实 reranker 打出来的。
 * 所以：
 *
 * - 能确定：类条件分布、以及由此决定的可行阈值区间（决策带）
 * - 不能确定：两类在真实流量里的占比（影响 precision 与成本换算，但不影响 tpr/fpr）
 *
 * 为什么 tpr/fpr 与流行度无关：两者都是**类内比例**（正类里被抓到的比例、负类里被误伤的比例），
 * 加权两类在总体中的占比不会改变各自的类内比例。这一点极易被搞错——很多"阈值随流行度漂移"
 * 的说法实际混淆了 precision 与 fpr。真正让阈值失效的不是流行度，而是**类内分布位移**
 * （生产里的负样本比构造出来的更难）。
 *
 * 因此决策带的用法是：把它当成"在**这批**类内分布下，阈值可以落在哪里"的证据，
 * 并显式报告带有多宽、由哪两条样本决定、去掉它们会不会塌缩。
 * 带宽很窄时，正确的结论不是"就用中点"，而是"还需要更多落在带内的标注"。
 */
import type { ConfidencePolicy } from "./profile";
import type { GateEvaluator, LabeledCaseWithChunks } from "./calibration";

/** 决策带里用来指认样本的最小信息 */
export interface BandSample {
  id: string;
  /** 该样本的 topScore（闸门主判据作用的对象） */
  topScore: number;
  shouldEscalate: boolean;
  /** 可选的来源标记（例如构造地层 near_miss / out_of_scope） */
  stratum?: string;
}

export interface BandInversion {
  /** 负样本（答得出来）却比某个正样本分数更低 */
  negativeId: string;
  positiveId: string;
  /** 负样本 topScore */
  negativeTop: number;
  /** 正样本 topScore */
  positiveTop: number;
}

export interface DecisionBand {
  /** 可行阈值区间下沿（开）：最简单的正样本，阈值必须**高于**它 */
  low: number;
  /** 可行阈值区间上沿（闭）：最难的负样本，阈值**不得超过**它 */
  high: number;
  /** high − low。> 0 表示存在可行阈值；≤ 0 表示两类在单阈值下不可分 */
  width: number;
  /** 带中点。不可分时为 null——不给一个假装可用的数 */
  midpoint: number | null;
  separable: boolean;
  /**
   * 带宽对"去掉决定它的那条样本"的敏感度。
   * 两者都远大于 width 时，说明这条带是由**单条样本**撑起来的，随时会塌——不是稳健证据。
   */
  widthWithoutHardestNegative: number | null;
  widthWithoutEasiestPositive: number | null;
  limiting: {
    /** 正类里分数最高的那条（最容易被漏掉的） */
    easiestPositive: BandSample | null;
    /** 负类里分数最低的那条（最容易被误伤的） */
    hardestNegative: BandSample | null;
  };
  /** 不可分时：分数落在重叠区 [high, low] 的样本，这些就是需要补标注的 */
  overlapping: BandSample[];
  /** 不可分时：具体的倒置对（最多列 20 条，避免报告爆炸） */
  inversions: BandInversion[];
  positives: number;
  negatives: number;
  /** 人话结论，可直接进报告 */
  reason: string;
}

/** 取一条样本的 topScore；空分布视为最低（0），与生产实现一致 */
export function topOf(chunkScores: number[]): number {
  return chunkScores.length === 0 ? 0 : Math.max(...chunkScores);
}

function toBandSample(item: LabeledCaseWithChunks, stratum?: string): BandSample {
  return {
    id: item.id,
    topScore: Number(topOf(item.chunkScores).toFixed(4)),
    shouldEscalate: item.shouldEscalate,
    ...(stratum !== undefined ? { stratum } : {}),
  };
}

/**
 * 算决策带。
 *
 * 注意 `low` 与 `high` 的定义方向：正类（应转人工）希望分数**低**，
 * 所以"最简单的正样本"是正类里分数最高的那条，它必须低于阈值。
 * 反过来"最难的负样本"是负类里分数最低的那条，它必须不低于阈值。
 */
export function decisionBand(
  cases: LabeledCaseWithChunks[],
  strata?: Map<string, string>,
): DecisionBand {
  const positives = cases.filter((c) => c.shouldEscalate);
  const negatives = cases.filter((c) => !c.shouldEscalate);

  if (positives.length === 0 || negatives.length === 0) {
    return {
      low: 0,
      high: 1,
      width: 1,
      midpoint: null,
      separable: false,
      widthWithoutHardestNegative: null,
      widthWithoutEasiestPositive: null,
      limiting: { easiestPositive: null, hardestNegative: null },
      overlapping: [],
      inversions: [],
      positives: positives.length,
      negatives: negatives.length,
      reason:
        positives.length === 0
          ? "没有正类样本（应转人工），决策带无从谈起"
          : "没有负类样本（答得出来），决策带无从谈起",
    };
  }

  const hardestNegative = negatives.reduce((best, cur) =>
    topOf(cur.chunkScores) < topOf(best.chunkScores) ? cur : best,
  );
  const easiestPositive = positives.reduce((best, cur) =>
    topOf(cur.chunkScores) > topOf(best.chunkScores) ? cur : best,
  );

  const low = Number(topOf(easiestPositive.chunkScores).toFixed(4));
  const high = Number(topOf(hardestNegative.chunkScores).toFixed(4));
  const width = Number((high - low).toFixed(4));
  const separable = low < high;

  const without = (list: LabeledCaseWithChunks[], drop: LabeledCaseWithChunks) =>
    list.filter((c) => c.id !== drop.id);

  const posLeft = without(positives, easiestPositive);
  const negLeft = without(negatives, hardestNegative);
  const widthIf = (pos: LabeledCaseWithChunks[], neg: LabeledCaseWithChunks[]) => {
    if (pos.length === 0 || neg.length === 0) return null;
    const l = Math.max(...pos.map((c) => topOf(c.chunkScores)));
    const h = Math.min(...neg.map((c) => topOf(c.chunkScores)));
    return Number((h - l).toFixed(4));
  };

  const sampleOf = (item: LabeledCaseWithChunks): BandSample =>
    toBandSample(item, strata?.get(item.id));

  // 不可分时把重叠区里的样本与具体倒置对列出来，报告才有可操作性
  const overlapping: BandSample[] = [];
  const inversions: BandInversion[] = [];
  if (!separable) {
    for (const item of cases) {
      const t = topOf(item.chunkScores);
      if (t >= high && t <= low) overlapping.push(sampleOf(item));
    }
    outer: for (const neg of negatives) {
      for (const pos of positives) {
        if (topOf(neg.chunkScores) < topOf(pos.chunkScores)) {
          inversions.push({
            negativeId: neg.id,
            positiveId: pos.id,
            negativeTop: Number(topOf(neg.chunkScores).toFixed(4)),
            positiveTop: Number(topOf(pos.chunkScores).toFixed(4)),
          });
          if (inversions.length >= 20) break outer;
        }
      }
    }
  }

  const reason = separable
    ? `可行阈值区间 (${low}, ${high}]，带宽 ${width.toFixed(4)}；` +
      `由「最难的负样本 ${hardestNegative.id}=${high}」与「最简单的正样本 ${easiestPositive.id}=${low}」共同决定`
    : `两类在单阈值下**不可分**：最难的负样本（${hardestNegative.id}）分数 ${high} 已低于最简单的正样本（${easiestPositive.id}）的 ${low}。` +
      `不存在任何 floor 能同时做到「不漏正类」与「不误伤负类」——` +
      `需要补标注确认这两条，或改用更多参数/更好的召回`;

  return {
    low,
    high,
    width,
    midpoint: separable ? Number(((low + high) / 2).toFixed(4)) : null,
    separable,
    widthWithoutHardestNegative: widthIf(positives, negLeft),
    widthWithoutEasiestPositive: widthIf(posLeft, negatives),
    limiting: {
      easiestPositive: sampleOf(easiestPositive),
      hardestNegative: sampleOf(hardestNegative),
    },
    overlapping,
    inversions,
    positives: positives.length,
    negatives: negatives.length,
    reason,
  };
}

export interface TradeoffRow {
  threshold: number;
  tpr: number;
  fpr: number;
  /** 该阈值下被判低置信的比例（类内比例，与流行度无关） */
  flaggedRate: number;
  tp: number;
  fp: number;
  positives: number;
  negatives: number;
}

export interface TradeoffOptions {
  /** 用哪些候选阈值；默认取所有正类 topScore 与负类 topScore 的并集 */
  thresholds?: number[];
  /** 是否用注入的闸门函数而不是单阈值。默认 true（衡量部署中的判决函数） */
  evaluate?: GateEvaluator;
  basePolicy?: ConfidencePolicy;
}

/**
 * 阈值取舍表。
 *
 * **这张表与流行度无关**，因为 tpr/fpr 都是类内比例。把它标出来是刻意的：
 * 构造数据的流行度是我编的，但类内分布是真的，所以这张表可以直接采信；
 * 反过来，"precision 是多少"这种依赖流行度的问题，构造数据回答不了，本函数也不输出 precision。
 */
export function thresholdTradeoff(
  cases: LabeledCaseWithChunks[],
  options: TradeoffOptions = {},
): TradeoffRow[] {
  const positives = cases.filter((c) => c.shouldEscalate);
  const negatives = cases.filter((c) => !c.shouldEscalate);
  if (positives.length === 0 || negatives.length === 0) return [];

  const candidates =
    options.thresholds ??
    [...new Set([...positives, ...negatives].map((c) => Number(topOf(c.chunkScores).toFixed(4))))].sort(
      (a, b) => a - b,
    );

  const rows: TradeoffRow[] = [];
  for (const threshold of candidates) {
    let tp = 0;
    let fp = 0;
    for (const item of positives) {
      if (isFlagged(item, threshold, options)) tp += 1;
    }
    for (const item of negatives) {
      if (isFlagged(item, threshold, options)) fp += 1;
    }
    rows.push({
      threshold: Number(threshold.toFixed(4)),
      tpr: Number((tp / positives.length).toFixed(4)),
      fpr: Number((fp / negatives.length).toFixed(4)),
      flaggedRate: Number(((tp + fp) / (positives.length + negatives.length)).toFixed(4)),
      tp,
      fp,
      positives: positives.length,
      negatives: negatives.length,
    });
  }
  return rows;
}

function isFlagged(
  item: LabeledCaseWithChunks,
  threshold: number,
  options: TradeoffOptions,
): boolean {
  if (options.evaluate) {
    const policy = { ...(options.basePolicy as ConfidencePolicy), floor: threshold };
    return options.evaluate(item.chunkScores, policy).lowConfidence;
  }
  // 单阈值口径：闸门主判据就是 topScore < floor
  return topOf(item.chunkScores) < threshold;
}

/** 把带宽转成"这条带稳不稳"的一句话结论，供报告直接用 */
export function describeBandStability(band: DecisionBand): string {
  if (!band.separable) return "不可分——没有可行的单阈值";
  const width = band.width;
  const bare = band.widthWithoutHardestNegative;
  const barest = band.widthWithoutEasiestPositive;
  const fragile =
    (bare !== null && Math.abs(bare - width) > width) ||
    (barest !== null && Math.abs(barest - width) > width);
  if (fragile) {
    return `带宽 ${width.toFixed(4)}，但去掉决定它的单条样本后变化极大（${bare} / ${barest}）——` +
      `说明这条带由少数样本撑起，不是稳健证据`;
  }
  if (width < 0.05) {
    return `带宽仅 ${width.toFixed(4)}，余量很薄：任何分布位移都可能让两类倒置。` +
      `「就能用中点」是错的结论，正确动作是补 0.30~0.45 区间的标注`;
  }
  return `带宽 ${width.toFixed(4)}，余量充足`;
}
