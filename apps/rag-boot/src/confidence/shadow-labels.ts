/**
 * 影子模式弱标签采集：在没有人工接管数据时，把**真实用户行为**变成标定标签。
 *
 * ## 为什么需要它
 *
 * `pnpm calibrate` 的实测标定（provenance=measured）要求每条样本带
 * `shouldEscalate` 真值——上线前没有人工接管记录，这个字段就没有可信来源。
 * 构造数据（synthetic.ts）只能产出 provisional 先验，这是刻意的边界。
 *
 * 但有一类真值其实一直在产生，只是从没被收集：**用户自己**。
 * 用户对上一轮答案的行为是闸门判决的直接反馈：
 *
 * - 下一轮直接说「转人工」→ 上一轮不该放行（shouldEscalate=true）
 * - 下一轮换个说法重复同一个问题 → 上一轮没解决（shouldEscalate=true）
 * - 会话正常结束 / 宿主确认解决 → 上一轮放行是对的（shouldEscalate=false）
 *
 * 这些是**结果标签**，不是模型自评，所以出处记 `measured`——与构造数据的
 * `constructed` 在 profile 守卫里走的是同一套诚实机制。
 *
 * ## 为什么是"影子"
 *
 * 采集器只**记录**判决，不改变任何判决。闸门行为完全不变，攒下的数据用于
 * 离线重标定。这保证接入零风险：标签逻辑错了最多是数据废了，不会污染线上行为。
 *
 * ## 边界（必须如实说）
 *
 * - 「转人工」≠「知识库答不了」：用户可能只是着急。它度量的是**闸门该不该拦**，
 *   恰好就是 shouldEscalate 的定义，但噪声比人工标注高——标定侧的 Wilson 区间
 *   与留出集会吸收一部分，吸收不掉的属于流行度偏差（和构造数据同一类局限）。
 * - 「重复提问」用词面相似度判定（2-gram Jaccard，阈值见 options），
 *   宁可偏低：漏报丢一条标签，误报只多一条噪声标签。
 * - 未标记的轮次**不会**被导出——宁缺毋滥，导出格式与 `calibrate --input` 的
 *   JSONL schema 完全一致，拿来就能标。
 */
import { z } from 'zod/v4';
import { isHumanRequest } from '../escalation';

/** 一轮知识问答的判决快照（闸门实际看到了什么） */
export const ShadowTurnRecordSchema = z.object({
  /** 全局唯一轮次 id */
  id: z.string().min(1),
  threadId: z.string().min(1),
  tenantId: z.string().default(''),
  /** 用户问题原文（仅存内存用于相似度判定，不随标定数据导出） */
  query: z.string().min(1),
  /** rerank 后的完整分数分布——标定硬前提（闸门参数作用在这个尺度上） */
  chunkScores: z.array(z.number().min(0).max(1)),
  /** 链路实际算出的合成分数 */
  score: z.number().min(0).max(1),
  /** 闸门当轮的真实判决 */
  lowConfidence: z.boolean(),
  /** 判决依据的阈值（回放时还原"当时为什么这么判"） */
  threshold: z.number().min(0).max(1).default(0.35),
  /** 生效 profile 的出处标记，例如 exact/provisional */
  profile: z.string().default('unknown'),
  at: z.number(),
  /** 弱标签。null = 用户行为还没给出信号 */
  label: z
    .object({
      shouldEscalate: z.boolean(),
      basis: z.enum([
        'explicit_human_request',
        'repeated_question',
        'session_resolved',
      ]),
      labeledAt: z.number(),
    })
    .nullable()
    .default(null),
});
export type ShadowTurnRecord = z.infer<typeof ShadowTurnRecordSchema>;

/** 标定运行时前提：导出 JSONL 时逐条带上，供 calibrate 按三元组分组 */
export interface ShadowContext {
  rerankerModel: string;
  kbVersion: string;
  domain: string;
}

export interface ShadowLabelCollectorOptions {
  context: ShadowContext;
  /**
   * 重复问题判定的词面相似度阈值（2-gram Jaccard），默认 0.35。
   *
   * 为什么这么低：中文同义改写共享的是**主体词**而非句式，实测同义改写约 0.44、
   * 无关话题约 0.0——两者之间留了足够余量。阈值宁可偏低（多打 repeated_question），
   * 因为漏报（真重复没认出来）会丢一条标签，而误报（把换话题当成重复）只多一条噪声标签；
   * 标定侧的留出集与敏感性分析吸收噪声，但吸收不掉系统性缺数据。
   */
  similarityThreshold?: number;
  clock?: () => number;
  idFactory?: () => string;
  /**
   * 记录或标签变化后的回调（宿主侧持久化入口，如写文件）。
   * 采集器本身零 I/O——持久化策略（路径、频率、格式）属于宿主，不属于判决逻辑。
   */
  onChange?: (snapshot: ShadowTurnRecord[]) => void;
}

/** 文本归一化：去标点/空白/大小写，只留判定用的字符 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 字符 2-gram 集合（长度 <2 时退化为整串单 gram） */
function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  if (text.length < 2) {
    if (text.length === 1) grams.add(text);
    return grams;
  }
  for (let i = 0; i + 2 <= text.length; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

/** 2-gram Jaccard 相似度。粗糙是刻意的：这里只区分"换个说法问同一件事"与"换了话题" */
export function questionSimilarity(a: string, b: string): number {
  const ga = bigrams(normalizeText(a));
  const gb = bigrams(normalizeText(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / (ga.size + gb.size - shared);
}

/**
 * 影子采集器。
 *
 * 用法（宿主侧，如 server/rag-bot）：
 * ```ts
 * const collector = new ShadowLabelCollector({
 *   context: { rerankerModel: "Qwen3-Reranker-4B", kbVersion: "kb-2026-09", domain: "优选商城售后" },
 * });
 * // 每轮知识问答判决后：
 * collector.recordTurn({ threadId, tenantId, query, chunkScores, score, lowConfidence, threshold, profile });
 * // 每轮入口（含非知识路径）：
 * collector.observeTurnStart({ threadId, query });
 * // 会话结束且未转人工时：
 * collector.markResolved(threadId);
 * // 攒够后导出给标定：
 * writeFileSync("shadow.jsonl", collector.toCalibrationJsonl());
 * // → pnpm calibrate --input shadow.jsonl --out config/confidence
 * ```
 */
export class ShadowLabelCollector {
  private readonly records: ShadowTurnRecord[] = [];
  /** 每线程最近一条**未标记**的记录，下一轮行为来了就结算它 */
  private readonly openByThread = new Map<string, ShadowTurnRecord>();
  private readonly similarityThreshold: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private seq = 0;

  constructor(private readonly options: ShadowLabelCollectorOptions) {
    this.similarityThreshold = options.similarityThreshold ?? 0.35;
    this.clock = options.clock ?? (() => Date.now());
    this.seq = 0;
    this.idFactory =
      options.idFactory ??
      (() => `shadow-${this.clock().toString(36)}-${(this.seq += 1)}`);
  }

  /** 记录一轮知识问答的判决（影子模式：只记录，不改变判决） */
  recordTurn(input: {
    threadId: string;
    tenantId?: string;
    query: string;
    chunkScores: number[];
    score: number;
    lowConfidence: boolean;
    threshold?: number;
    profile?: string;
  }): ShadowTurnRecord {
    const record = ShadowTurnRecordSchema.parse({
      id: this.idFactory(),
      threadId: input.threadId,
      tenantId: input.tenantId ?? '',
      query: input.query,
      chunkScores: input.chunkScores,
      score: input.score,
      lowConfidence: input.lowConfidence,
      threshold: input.threshold,
      profile: input.profile,
      at: this.clock(),
      label: null,
    });
    this.records.push(record);
    this.openByThread.set(record.threadId, record);
    this.notify();
    return record;
  }

  /** 变更通知（宿主持久化）。回调异常不反噬判决链路——影子模式不干预主流程是硬约束 */
  private notify(): void {
    try {
      this.options.onChange?.(this.list());
    } catch {
      // 持久化失败丢的只是数据，不能让采集器把一次正常的对话请求打挂
    }
  }

  /**
   * 每轮入口调用：用本轮用户行为给**上一轮**打弱标签。
   *
   * 信号优先级：明确要求人工 > 重复提问。两个都没命中则保持未标记
   * （换了话题 ≠ 上一轮解决了，用户也可能只是没耐心打字）。
   */
  observeTurnStart(input: {
    threadId: string;
    query: string;
  }): ShadowTurnRecord[] {
    const open = this.openByThread.get(input.threadId);
    if (!open || open.label) return [];
    const now = this.clock();
    if (isHumanRequest(input.query)) {
      open.label = {
        shouldEscalate: true,
        basis: 'explicit_human_request',
        labeledAt: now,
      };
      this.openByThread.delete(input.threadId);
      this.notify();
      return [open];
    }
    if (
      questionSimilarity(open.query, input.query) >= this.similarityThreshold
    ) {
      open.label = {
        shouldEscalate: true,
        basis: 'repeated_question',
        labeledAt: now,
      };
      this.openByThread.delete(input.threadId);
      this.notify();
      return [open];
    }
    return [];
  }

  /**
   * 宿主确认会话正常解决（如会话结束且全程未转人工）时调用。
   * 这是唯一的弱负标签来源——"没信号"不算信号，必须显式声明。
   */
  markResolved(threadId: string): ShadowTurnRecord | null {
    const open = this.openByThread.get(threadId);
    if (!open || open.label) return null;
    open.label = {
      shouldEscalate: false,
      basis: 'session_resolved',
      labeledAt: this.clock(),
    };
    this.openByThread.delete(threadId);
    this.notify();
    return open;
  }

  /**
   * 从持久化快照恢复（宿主重启时调用）。
   *
   * 已标记轮次原样回来（那是攒了很久的标签数据）；未标记轮次恢复为"待结算"，
   * 下一轮用户行为还能补上。schema 校验失败直接抛——快照被改坏时宁可启动失败，
   * 也不要带着一份来路不明的"标定数据"继续攒。
   */
  static restore(
    snapshot: unknown[],
    options: ShadowLabelCollectorOptions,
  ): ShadowLabelCollector {
    const collector = new ShadowLabelCollector(options);
    for (const item of snapshot) {
      const record = ShadowTurnRecordSchema.parse(item);
      collector.records.push(record);
      if (!record.label) collector.openByThread.set(record.threadId, record);
    }
    return collector;
  }

  list(): ShadowTurnRecord[] {
    return this.records.map((record) => structuredClone(record));
  }

  /** 已标记的记录（人工抽检复核的入口） */
  labeled(): ShadowTurnRecord[] {
    return this.records
      .filter((record) => record.label !== null)
      .map((record) => structuredClone(record));
  }

  /** 攒了多少条正/负标签——够不够标定用（canCalibrate 要求每类 ≥50） */
  stats(): {
    total: number;
    labeled: number;
    positives: number;
    negatives: number;
  } {
    const labeled = this.records.filter((record) => record.label !== null);
    const positives = labeled.filter(
      (record) => record.label!.shouldEscalate,
    ).length;
    return {
      total: this.records.length,
      labeled: labeled.length,
      positives,
      negatives: labeled.length - positives,
    };
  }

  /**
   * 导出 `calibrate --input` 直接可吃的 JSONL。
   *
   * - 只导出已标记轮次；空 chunkScores 的记录跳过（标定硬前提，schema 会拒绝）
   * - `provenance: "measured"`：标签来自真实用户行为，不是构造
   * - 不含 query 原文：标定不需要，少一份 PII 滞留
   */
  toCalibrationJsonl(): string {
    const rows = this.records
      .filter(
        (record) => record.label !== null && record.chunkScores.length > 0,
      )
      .map((record) =>
        JSON.stringify({
          id: record.id,
          chunkScores: record.chunkScores.map((s) => Number(s.toFixed(4))),
          score: Number(record.score.toFixed(4)),
          shouldEscalate: record.label!.shouldEscalate,
          rerankerModel: this.options.context.rerankerModel,
          kbVersion: this.options.context.kbVersion,
          domain: this.options.context.domain,
          provenance: 'measured',
          // 附加字段：calibrate 的 schema 会剥掉它，但原始文件留着可审计
          labelBasis: record.label!.basis,
        }),
      );
    return rows.length > 0 ? rows.join('\n') + '\n' : '';
  }
}
