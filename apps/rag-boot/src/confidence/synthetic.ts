/**
 * 构造标定数据（synthetic calibration data）的纯逻辑部分。
 *
 * ## 这个模块存在的理由，以及它不做什么
 *
 * 项目缺真实人工接管数据，所以想"自己跑链路生成数据"。这件事能做，但要精确知道
 * **哪一部分是真的、哪一部分是编的**：
 *
 * - **真的**：分数。真 embedding + 真 reranker + 真知识库，打出来的分数向量就是
 *   生产会拿到的那个（前提是切块参数一致）。
 * - **编的**：标签的来源，以及两类在真实流量里的占比。
 *
 * 标签为什么算"编"：这里用 `stratum` 反推 `shouldEscalate`——我判断某个问题
 * 知识库里答不了，就把它标成正类。这个判断**由构造保证**（有依据、可复核），
 * 不是模型自评，但它的难度分布反映的是**我想象中的**难负样本，不是线上真实分布。
 *
 * 所以产出只能是 `provenance: "constructed"` 的 **provisional 先验**，
 * 由 `profile.ts` 的守卫保证它无法被标成 `calibrated: true`。
 *
 * ## 为什么不"用链路自己的输出当标签"
 *
 * 那条路是循环论证：拿 `lowConfidence` 当 `shouldEscalate`，等价于让闸门给自己出题。
 * ROC 会漂亮得毫无意义（阈值恰好落在它自己身上），而这正是"拍一个 0.35"想避免的问题。
 *
 * 本模块只做纯计算（切块、地层→标签、装配、体检），不碰网络。I/O 在
 * `scripts/generate-calibration-data.ts`。
 */
import { z } from "zod/v4";

/** 生产切块参数（与 vectorstore.ts 保持一致，否则分数尺度不可比） */
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;

export const StratumSchema = z.enum(["answerable", "near_miss", "out_of_scope"]);
export type Stratum = z.infer<typeof StratumSchema>;

export const SeedQuerySchema = z.object({
  id: z.string().min(1),
  stratum: StratumSchema,
  q: z.string().min(1),
  /**
   * 可答地层应命中的块 id（`文件名.md#章节名`）。用于**自检**：
   * 若目标块没被召回，这条样本的分数反映的是"检索没找到"，而不是"知识库没有"，
   * 标签就错了。这类样本会被剔除并报出。
   */
  target: z.array(z.string()).default(() => []),
  /** 判定依据（为什么它答得了／答不了）。构造标签必须可复核，否则就是随手标的 */
  basis: z.string().default(""),
});
export type SeedQuery = z.infer<typeof SeedQuerySchema>;

export const SeedQuerySetSchema = z.object({
  kbVersion: z.string().min(1),
  domain: z.string().min(1),
  queries: z.array(SeedQuerySchema).min(1),
});
export type SeedQuerySet = z.infer<typeof SeedQuerySetSchema>;

/**
 * 地层 → 标签。这是"构造标签"的**全部**内容，集中在一处便于审查。
 *
 * - `answerable`：答案在库里 → 不该转人工（负类）
 * - `near_miss` / `out_of_scope`：知识库答不了 → 该转人工（正类）
 *
 * `near_miss` 与 `out_of_scope` 分成两个地层是刻意的：前者是"话题在库里、
 * 具体参数不在"，分数会落在中等区间，是群像式幻觉的高发区；后者是"话题完全不在库里"，
 * 分数贴近 0。两者难度差一个量级，混在一起会掩盖真正的风险区。
 */
export function labelForStratum(stratum: Stratum): boolean {
  return stratum !== "answerable";
}

export interface KbSection {
  /** 稳定 id：`文件名.md#章节名` */
  id: string;
  doc: string;
  heading: string;
  /** 真实喂给 embedding/rerank 的文本，格式与生产一致 */
  content: string;
}

export interface SplitResult {
  sections: KbSection[];
  /**
   * 超过 chunkSize 的章节数。> 0 说明本模块的贪心切分只是近似
   * （生产用 langchain 的 RecursiveCharacterTextSplitter），分数尺度会有偏差，报告里必须写出来。
   */
  oversizedSections: number;
}

/**
 * 按二级标题切章节，复刻 `vectorstore.ts` 的 `splitByHeadingLevel(content, 2, { prependIntro: true })`：
 * 把文首标题块拼到每个章节前（保留手册标题上下文），section 取章节标题。
 *
 * 章节超长时按段落贪心切分并带 overlap。这是对生产 splitter 的**近似**，
 * 近似程度由 `oversizedSections` 如实报告，而不是假装等价。
 */
export function splitSections(
  fileName: string,
  markdown: string,
  options: { chunkSize?: number; chunkOverlap?: number } = {},
): SplitResult {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  const parts = markdown
    .split(/\n(?=## )/)
    .map((part) => part.trim())
    .filter(Boolean);

  const [titleBlock, ...rest] = parts;
  const body = parts.length <= 1 ? [] : rest;
  const blocks =
    body.length > 0
      ? body.map((section) => ({
          content: `${titleBlock}\n\n${section}`.trim(),
          heading: (/^##\s+(.+)$/m.exec(section)?.[1] ?? "未命名章节").trim(),
        }))
      : [{ content: markdown.trim(), heading: "全文" }];

  let oversized = 0;
  const sections: KbSection[] = [];
  for (const block of blocks) {
    const pieces =
      block.content.length <= chunkSize
        ? [block.content]
        : (() => {
            oversized += 1;
            return greedySplit(block.content, chunkSize, overlap);
          })();
    pieces.forEach((piece, index) => {
      sections.push({
        id: pieces.length === 1 ? `${fileName}#${block.heading}` : `${fileName}#${block.heading}#${index + 1}`,
        doc: fileName,
        heading: block.heading,
        content: piece,
      });
    });
  }

  return { sections, oversizedSections: oversized };
}

/** 按段落边界贪心装箱，尽量不切在句子中间；只有单段超长才硬切 */
function greedySplit(text: string, chunkSize: number, overlap: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  const out: string[] = [];
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    out.push(buffer.trim());
    buffer = overlap > 0 ? buffer.slice(Math.max(0, buffer.length - overlap)) : "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > chunkSize) {
      flush();
      for (let i = 0; i < paragraph.length; i += chunkSize - overlap) {
        out.push(paragraph.slice(i, i + chunkSize).trim());
      }
      buffer = "";
      continue;
    }
    if (buffer.length + paragraph.length + 2 > chunkSize) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return out.filter(Boolean);
}

export interface SeedValidation {
  errors: string[];
  warnings: string[];
  byStratum: Record<Stratum, number>;
}

/**
 * 种子集体检。
 *
 * 重点拦两类会让**标签静默错掉**的问题：
 * 1. `answerable` 却没写 target —— 无法自检，等于放弃验证它真的答得了；
 * 2. target 指向不存在的块 —— 通常是文件名/章节名打错，会让自检永远失败。
 */
export function validateSeedSet(set: SeedQuerySet, sections: KbSection[]): SeedValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set(sections.map((s) => s.id));
  const queryIds = new Set<string>();
  const byStratum: Record<Stratum, number> = { answerable: 0, near_miss: 0, out_of_scope: 0 };

  for (const query of set.queries) {
    if (queryIds.has(query.id)) errors.push(`查询 id 重复：${query.id}`);
    queryIds.add(query.id);
    byStratum[query.stratum] += 1;

    if (!query.basis.trim()) {
      warnings.push(`${query.id} 没有写判定依据（basis）——构造标签必须可复核`);
    }
    if (query.stratum === "answerable") {
      if (query.target.length === 0) {
        errors.push(`${query.id} 是 answerable 但没给 target，无法自检它是否真的答得了`);
      }
      for (const target of query.target) {
        if (!ids.has(target)) errors.push(`${query.id} 的 target 不存在于知识库切块：${target}`);
      }
    } else if (query.target.length > 0) {
      warnings.push(`${query.id} 是 ${query.stratum} 却给了 target，地层与标注不一致`);
    }
  }

  if (byStratum.answerable === 0) errors.push("没有任何 answerable 样本，标不出负类");
  if (byStratum.near_miss === 0) {
    warnings.push(
      "没有 near_miss 样本：只剩「话题完全不在库里」这一类负样本，" +
        "它们的分数贴近 0，会把决策带撑得过宽，掩盖真正的风险区",
    );
  }

  return { errors, warnings, byStratum };
}

export interface SyntheticRecord {
  id: string;
  chunkScores: number[];
  score: number;
  shouldEscalate: boolean;
  rerankerModel: string;
  kbVersion: string;
  domain: string;
  /** 恒定 constructed。守卫据此拒绝把它当成实测标定 */
  provenance: "constructed";
  stratum: Stratum;
}

export interface DatasetManifest {
  kbVersion: string;
  domain: string;
  rerankerModel: string;
  generatedAt: string;
  /** 知识库切块数 */
  chunkCount: number;
  /** 超过 chunkSize 的章节数；> 0 表示切分只是近似，分数尺度会有偏差 */
  oversizedSections: number;
  total: number;
  byStratum: Record<Stratum, number>;
  positives: number;
  negatives: number;
  /** 正类（应转人工）占比。**这个是构造出来的，不是线上分布** */
  positiveShare: number;
  /**
   * 被剔除的样本：可答但目标块没被召回到。它们的低分来自"检索没打中",
   * 不是"知识库没有"，留着会变成错标的正类。
   */
  droppedAnswerableMisses: string[];
  warnings: string[];
  /** 必须随数据一起移交的声明，防止下游把它当实测标定 */
  caveats: string[];
}

export interface BuildInput {
  set: SeedQuerySet;
  rerankerModel: string;
  /** query id → 真实 rerank 分数向量 */
  scores: Map<string, number[]>;
  /** query id → 该次检索实际召回的块 id 列表（用于自检可答样本） */
  retrieved?: Map<string, string[]>;
  sections?: KbSection[];
  oversizedSections?: number;
  now?: () => Date;
}

export interface BuildResult {
  records: SyntheticRecord[];
  manifest: DatasetManifest;
}

const HONEST_CAVEATS = [
  "分数是真的：真 embedding + 真 reranker + 真知识库，前提是切块参数与生产一致。",
  "标签是构造的：由 stratum 判定「知识库答不了」，不是人工接管记录，也不是模型自评。",
  "流行度是编的：正类占比由种子集的构成决定，不等于线上真实求助分布。",
  "因此本数据只能定出类内分布与决策带，不能直接充当实测标定；" +
    "下游 profile 会被守卫标成 provisional=true，calibrated 保持 false。",
  "最容易被低估的一点：线上真实的负样本（客户问了、库里其实没有）比这里构造的更难更杂，" +
    "所以按本数据得到的阈值应视为**下限附近**的估计，真实阈值大概率不低于它。",
];

/**
 * 装配数据集与清单。
 *
 * 重要行为：**可答样本若没召回到目标块，直接剔除并报出**。
 * 因为它的低分来自检索失败而非知识缺失，留着会被当成"正类"，
 * 悄悄把一个错标签塞进标定集——这比少一条样本危险得多。
 */
export function buildSyntheticRecords(input: BuildInput): BuildResult {
  const { set, rerankerModel, scores, retrieved, sections } = input;
  const now = input.now ?? (() => new Date());

  const records: SyntheticRecord[] = [];
  const dropped: string[] = [];
  const byStratum: Record<Stratum, number> = { answerable: 0, near_miss: 0, out_of_scope: 0 };
  const warnings: string[] = [];

  for (const query of set.queries) {
    const chunkScores = scores.get(query.id);
    if (!chunkScores || chunkScores.length === 0) {
      warnings.push(`${query.id} 没有分数向量，已跳过`);
      continue;
    }

    if (query.stratum === "answerable" && query.target.length > 0 && retrieved) {
      const got = new Set(retrieved.get(query.id) ?? []);
      const hit = query.target.some((t) => got.has(t));
      if (!hit) {
        dropped.push(query.id);
        continue;
      }
    }

    byStratum[query.stratum] += 1;
    const top = Math.max(...chunkScores);
    records.push({
      id: query.id,
      chunkScores: chunkScores.map((s) => Number(s.toFixed(4))),
      // score 这里就等于 topScore：本数据只用于定 floor / 决策带，
      // 合成分数要由标定侧用同一 policy 重算，不在这里编一个
      score: Number(top.toFixed(4)),
      shouldEscalate: labelForStratum(query.stratum),
      rerankerModel,
      kbVersion: set.kbVersion,
      domain: set.domain,
      provenance: "constructed",
      stratum: query.stratum,
    });
  }

  const positives = records.filter((record) => record.shouldEscalate).length;
  const negatives = records.length - positives;

  if (dropped.length > 0) {
    warnings.push(
      `剔除了 ${dropped.length} 条 answerable 样本（目标块未被召回）：${dropped.join("、")}。` +
        `它们的低分来自检索没打中，不是知识库没有——留着会变成错标的正类。`,
    );
  }
  if (input.oversizedSections && input.oversizedSections > 0) {
    warnings.push(
      `有 ${input.oversizedSections} 个章节超过 chunkSize，本模块用的是贪心近似切分，` +
        `与生产的 langchain splitter 不完全一致，分数尺度可能有小幅偏差。`,
    );
  }

  const manifest: DatasetManifest = {
    kbVersion: set.kbVersion,
    domain: set.domain,
    rerankerModel,
    generatedAt: now().toISOString(),
    chunkCount: sections?.length ?? 0,
    oversizedSections: input.oversizedSections ?? 0,
    total: records.length,
    byStratum,
    positives,
    negatives,
    positiveShare: records.length === 0 ? 0 : Number((positives / records.length).toFixed(4)),
    droppedAnswerableMisses: dropped,
    warnings,
    caveats: [...HONEST_CAVEATS],
  };

  return { records, manifest };
}

/** 用构造数据下的三类分数向量给决策带报告附一句"哪个地层在搅局" */
export function dominantRiskStratum(
  records: SyntheticRecord[],
): { stratum: Stratum; topScore: number; id: string } | null {
  const positives = records.filter((record) => record.shouldEscalate);
  if (positives.length === 0) return null;
  const worst = positives.reduce((best, cur) =>
    Math.max(...cur.chunkScores) > Math.max(...best.chunkScores) ? cur : best,
  );
  return {
    stratum: worst.stratum,
    topScore: Number(Math.max(...worst.chunkScores).toFixed(4)),
    id: worst.id,
  };
}
