/**
 * T2.4 置信度与低置信兜底
 *
 * 架构图中知识问答流程的产出是「引用 + 置信度」，置信度是转人工触发条件之一（T5.1）。
 *
 * 关键设计（清单 365 行）：**不要用 LLM 自评置信度**。
 * 自评置信度不可靠——模型倾向于对自己的输出过度自信，且多花一次调用。
 * 这里用 rerank 分数 + 引用覆盖度两个可计算的信号组合。
 *
 * ── 群像式幻觉与相对 coverage 的失效（本文件的核心加固点）────────────────
 *
 * 旧实现把 coverage 定义成「分数达到最高分 60% 的 chunk 占比」。这个口径是**相对**的，
 * 于是它衡量的是「分数分布有多平」，而不是「有多少条真的相关」。两种错向都出现：
 *
 *   1) 群像式幻觉（假阴性）：query 在库里根本没有答案，召回的 10 条却都在 0.30 上下。
 *      因为大家都"接近最高分"，coverage = 1.0；topScore 一旦蹭过阈值，闸门放行，
 *      模型拿着一堆勉强相关的 chunk 编出一个语气笃定的答案。
 *   2) 一强多弱（误伤）：只有一条真正命中（0.91），其余是噪声 —— 噪声够不到 0.91×0.6，
 *      coverage 反而掉到 0.2，把一次本来干净的命中扣了分。
 *
 * 另外旧实现里的 min-max 归一化（(top-min)/(max-min)）在数学上是**恒定 1**：
 * top 按定义就是 max，所以 `score = 0.7 + 0.3 × coverage` 永远落在 [0.7, 1]，
 * `score < threshold` 这条判断一次都不可能触发（除了全 0）。也就是说旧的合成分数
 * 是装饰性的，真正的闸门只有 `topScore < threshold` 一条——和 T9.1 里被修掉的
 * 「ASR 加权平均永远够不到阈值」是同一类缺陷。
 *
 * 本版改为三条**绝对**判据，且都锚在标定过的绝对分数线上（见 confidence/profile.ts）：
 *
 *   - floor（下限）：topScore < floor → 知识库里没有，直接低置信。
 *   - solid（实心线）：topScore >= solid → 单条强命中即可独立支撑，不再要求旁证。
 *   - 中间地带 [floor, solid)：必须同时满足
 *       · 旁证（coverage 用绝对口径，数「过线」的条数）+ 
 *       · 区分度（top 与全局最低分的落差足够大，说明模型能把它和噪声分开）
 *     两个都满足才算「有支撑」，否则低置信。
 *
 * 群像式幻觉被单独命名（`flockHallucination`）：一簇分数挤在 [floor, solid) 里、
 * 谁都领先不了多少。它比"单纯低分"更危险——因为每条看起来都"还行"，
 * 合成出来的答案读起来很顺，所以需要独立可观测，而不是混进 lowConfidence 里看不见。
 */
import type { RerankedChunk } from "../schema";
import {
  DEFAULT_CONFIDENCE_POLICY,
  type ConfidencePolicy,
} from "../confidence/profile";

export interface ConfidenceOptions {
  /**
   * @deprecated 等价于 `policy.floor`，保留是为了不破坏既有调用方（测试与外部注入）。
   * 新代码请直接传 `policy`，或让 agent 图从标定 profile 解析。
   */
  threshold?: number;
  /** 支撑度对 score 的乘性折扣强度 */
  coverageWeight?: number;
  /** 完整的判决参数（通常来自标定 profile） */
  policy?: Partial<ConfidencePolicy>;
}

export interface ConfidenceResult {
  /** 0-1；乘性折扣后可低于 floor（这正是它能当闸门用的前提） */
  score: number;
  lowConfidence: boolean;
  /** 生效的绝对下限 */
  threshold: number;
  /** 最高 rerank 分数 */
  topScore: number;
  /**
   * 引用覆盖度（**绝对口径**）：分数达到 floor 的 chunk 占比。
   * 与旧版的区别：旧版是 `>= max * 0.6`（相对最高分），会把群像算成满分。
   */
  coverage: number;
  /** 过线（>= floor）的 chunk 条数 */
  supportCount: number;
  /** 全局落差 topScore - minScore：区分度原始值 */
  spread: number;
  /** 归一化区分度 0-1，1 表示落差已达 minRange，模型能把命中与噪声分开 */
  discrimination: number;
  /** 中间地带是否拿到了足够旁证（旁证占比 + 区分度双条件） */
  corroborated: boolean;
  /** 是否命中「群像式幻觉」特征：一簇分数挤在 [floor, solid) 且互相领先不明显 */
  flockHallucination: boolean;
  /** 生效参数，便于 tracing / 回放时解释判决 */
  policy: ConfidencePolicy;
}

/** 合并调用方参数与默认政策；显式 threshold / coverageWeight 优先级最高 */
function resolvePolicy(options: ConfidenceOptions): ConfidencePolicy {
  const policy: ConfidencePolicy = { ...DEFAULT_CONFIDENCE_POLICY, ...(options.policy ?? {}) };
  if (options.coverageWeight !== undefined) policy.coverageWeight = options.coverageWeight;
  if (options.threshold !== undefined) policy.floor = options.threshold;
  return policy;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * 计算置信度。
 *
 * score = topScore × (1 - w + w × support)
 *   其中 w = coverageWeight，support = 强领头时取 1，否则取 旁证占比 × 区分度。
 * 乘性结构（而不是加权平均）的理由与 T9.1 一致：**可信度不可能高于支撑最弱的一环**。
 * 加权平均压制不住"一堆勉强相关的 chunk"，乘性可以。
 */
export function computeConfidence(
  chunks: RerankedChunk[],
  options: ConfidenceOptions = {},
): ConfidenceResult {
  const policy = resolvePolicy(options);
  const threshold = policy.floor;

  if (chunks.length === 0) {
    return {
      score: 0,
      lowConfidence: true,
      threshold,
      topScore: 0,
      coverage: 0,
      supportCount: 0,
      spread: 0,
      discrimination: 0,
      corroborated: false,
      flockHallucination: false,
      policy,
    };
  }

  const scores = chunks.map((c) => c.rerankScore);
  const topScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const spread = topScore - minScore;

  // 区分度：落差相对 minRange 归一。minRange 来自标定，代表"模型确实能分开"的落差。
  const rangeDenominator = Math.max(policy.minRange, Number.EPSILON);
  const discrimination = clamp01(spread / rangeDenominator);

  // 绝对口径覆盖度：只有真的过 floor 的 chunk 才算支撑。
  // 这一步就是群像式幻觉的主解——10 条 0.30 里只有 0 条过线，coverage 就是 0，不是 80%。
  const supportCount = scores.filter((s) => s >= threshold).length;
  const coverage = supportCount / scores.length;

  // 强领头：一条就够，不再要求旁证（修掉旧版对"一强多弱"的误伤）
  const leaderStrong = topScore >= policy.solid;

  // 中间地带要求「多条绝对过线」且「分布有区分度」同时成立。
  // supportCount >= 2 是硬条件：占比在候选集很小时会骗人（2 条里 1 条过线就是 50% 占比），
  // 而"旁证"这个词本身就意味着不止一条。缺了它会退化成"一条中等分 + 一堆噪声"也能过。
  const hasSupport = coverage >= policy.minSupportShare && supportCount >= 2;
  const hasDiscrimination = discrimination >= 1;
  const corroborated = hasSupport && hasDiscrimination;

  // 群像式幻觉：top 只在 [floor, solid) 里，且整簇分数挤在一起，谁也没明显领先
  const flockHallucination =
    chunks.length >= policy.flockMinChunks &&
    topScore >= threshold &&
    topScore < policy.solid &&
    discrimination <= policy.flockDiscriminationMax;

  const support = leaderStrong ? 1 : coverage * discrimination;
  const score = clamp01(
    topScore * (1 - policy.coverageWeight + policy.coverageWeight * support),
  );

  const lowConfidence =
    topScore < threshold ||
    flockHallucination ||
    (!leaderStrong && !corroborated) ||
    score < threshold;

  return {
    score: Number(score.toFixed(4)),
    lowConfidence,
    threshold,
    topScore: Number(topScore.toFixed(4)),
    coverage: Number(coverage.toFixed(4)),
    supportCount,
    spread: Number(spread.toFixed(4)),
    discrimination: Number(discrimination.toFixed(4)),
    corroborated,
    flockHallucination,
    policy,
  };
}

/** 低置信时的不确定表述前缀。T2.4 要求「不做肯定断言」 */
export const LOW_CONFIDENCE_PREFIX =
  "根据现有资料，以下回答可能不够完整，";

export const LOW_CONFIDENCE_SUFFIX =
  "如果仍未解决你的问题，可以回复「转人工」，我会为你接入人工客服。";

/**
 * 给低置信答案套上不确定表述。
 * 只在低置信时套——高置信答案平白加免责声明会显得不自信，反而伤害体验。
 */
export function withConfidenceTone(answer: string, lowConfidence: boolean): string {
  if (!lowConfidence) return answer;
  if (answer.includes(LOW_CONFIDENCE_PREFIX)) return answer;
  return `${LOW_CONFIDENCE_PREFIX}${answer}\n\n${LOW_CONFIDENCE_SUFFIX}`;
}

/**
 * ASR 渠道的低转写置信度会拉低整体置信度（T9.1 要求）。
 *
 * 用**乘法**而不是加权平均，理由是后者在这里是装饰性的：
 * 加权平均（score×(1-w) + score×tc×w）即使 tc=0 也只能把 1.0 压到 0.6，
 * 永远够不到 0.35 的低置信阈值——看起来「影响了」，实际一次都没触发过兜底。
 *
 * 语义上乘法才是对的：**答案的可信度不可能高于「问题被听清的程度」**。
 * 一通完全没听清的电话，检索结果再像样也不能给出高置信答复。
 *
 * @param weight 乘性强度，1 = 完全按转写置信度缩放，0 = 不生效
 */
export function adjustForTranscriptConfidence(
  score: number,
  transcriptConfidence: number | null | undefined,
  weight = 1,
): number {
  if (transcriptConfidence === null || transcriptConfidence === undefined) return score;
  const tc = Math.min(1, Math.max(0, transcriptConfidence));
  const clamped = Math.min(1, Math.max(0, score));
  return Number((clamped * (1 - weight + weight * tc)).toFixed(4));
}
