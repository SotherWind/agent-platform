/**
 * T2.4 置信度与低置信兜底
 *
 * 架构图中知识问答流程的产出是「引用 + 置信度」，置信度是转人工触发条件之一（T5.1）。
 *
 * 关键设计（清单 365 行）：**不要用 LLM 自评置信度**。
 * 自评置信度不可靠——模型倾向于对自己的输出过度自信，且多花一次调用。
 * 这里用 rerank 分数 + 引用覆盖度两个可计算的信号组合。
 */
import type { RerankedChunk } from "../schema";

export interface ConfidenceOptions {
  /** rerank 分数阈值，低于它标记低置信 */
  threshold?: number;
  /** 引用覆盖度权重（0-1） */
  coverageWeight?: number;
}

export interface ConfidenceResult {
  /** 0-1 */
  score: number;
  lowConfidence: boolean;
  threshold: number;
  /** 最高 rerank 分数 */
  topScore: number;
  /** 引用覆盖度：有多少比例的 chunk 分数接近最高分 */
  coverage: number;
}

/**
 * 计算置信度。
 *
 * score = topScore 归一化 × (1 - w) + coverage × w
 * - topScore：最好的一条有多相关（能不能答）
 * - coverage：次好的几条是否也相关（答得有没有支撑）
 *
 * 只取最高分会漏掉「一条相关、其余全不相关」的情况——那种答案往往只有一句
 * 上下文支撑，容易过度概括，所以用 coverage 压一压。
 */
export function computeConfidence(
  chunks: RerankedChunk[],
  options: ConfidenceOptions = {},
): ConfidenceResult {
  const threshold = options.threshold ?? 0.35;
  const coverageWeight = options.coverageWeight ?? 0.3;

  if (chunks.length === 0) {
    return { score: 0, lowConfidence: true, threshold, topScore: 0, coverage: 0 };
  }

  const scores = chunks.map((c) => c.rerankScore);
  const topScore = Math.max(...scores);

  // 归一化：rerank 分数域不固定（不同模型量纲不同），用相对值更稳
  const max = topScore;
  const min = Math.min(...scores);
  const span = max - min;
  const normalizedTop = span > 0 ? (topScore - min) / span : topScore > 0 ? 1 : 0;

  // 覆盖度：分数达到最高分 60% 的 chunk 占比（至少一条，即最高分那条）
  const near = scores.filter((s) => max === 0 || s >= max * 0.6).length;
  const coverage = near / chunks.length;

  const score = Math.min(
    1,
    Math.max(
      0,
      normalizedTop * (1 - coverageWeight) + coverage * coverageWeight,
    ),
  );

  return {
    score: Number(score.toFixed(4)),
    // 硬门槛：最高 rerank 分数本身低于阈值时必须低置信，
    // 不能因为候选集只有一条就被相对归一化误判为高置信。
    lowConfidence: topScore < threshold || score < threshold,
    threshold,
    topScore,
    coverage: Number(coverage.toFixed(4)),
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
