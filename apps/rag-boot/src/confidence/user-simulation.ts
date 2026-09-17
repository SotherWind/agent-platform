/**
 * 用户模拟探针：回答"能不能靠模拟真实用户使用来测"。
 *
 * ## 结论先说
 *
 * 能模拟，但**不能把模拟用户的满意度当标定标签**。原因不是"模型不够像人"，而是一个结构性缺陷：
 *
 * 模拟用户能看到的只有**答案文本**。而群像式幻觉的定义特征就是"答案读起来很顺、很确定"。
 * 所以"看起来满意"与"其实被编造骗了"在模拟用户眼里是同一种东西——
 * 它对**恰好需要闸门去拦的那一类错误**是免疫的（或者说，是系统性偏向"放行"的）。
 *
 * 这不是随机噪声，而是**有方向的偏差**：拿它当标签会系统性调低阈值，
 * 让更多编造内容通过。所以模拟用户满意度比"没有标签"更糟。
 *
 * ## 那模拟能力用在哪
 *
 * 三件它确实擅长、且不损害标签可信度的事：
 *
 * 1. **生成真实感的输入**（本模块的 `questionSynthesisPrompt`）：由知识库章节自指令合成用户问题，
 *    解决"种子集是一个人拍脑袋写的、覆盖面窄"的问题。注意它只生成**输入**，不生成**标签**。
 * 2. **答案消融**（`buildAblatedCases`）：把承载答案的那一节从候选池里拿掉，
 *    构造出"**可证明**知识库答不了"的难负样本，而且提问措辞天然真实（问题是照着真实内容写的）。
 *    标签来自构造，不来自任何模型判断。
 * 3. **暴露幻觉率**（`classifyAnswerProbe`）：在被消融的上下文下让真模型作答，
 *    用**确定性**规则检查它有没有断言上下文里根本没有的具体数字。
 *    这一步的意义是把"模拟用户会被误导多少"变成一个可测量的数，而不是一个判断。
 *
 * ## 消融法的边界（不要当成"可证明答不了"的完全证明）
 *
 * 消融保证的是"**承载答案的那一节不可用**"，而不是"整个库里都没有答案"——相邻章节可能也含答案。
 * 所以消融样本要再过一道验证：如果模型在被消融的上下文下**答对了**（数字都有出处），
 * 说明这条其实答得了，应剔除。最终产出仍然标 `constructed`，不因为它更真实就升级成 `measured`。
 */
import { z } from "zod/v4";

import { extractAccountNumbers, extractCommitmentNumbers } from "../guardrails/output";
import type { KbSection } from "./synthetic";

/** 合成提问用的 system。刻意要求"像真实客户那样问"，而不是像文档标题那样问 */
export const QUESTION_SYNTHESIS_SYSTEM =
  "你在为一个电商售后客服系统构造测试用的问题。你只输出问题本身，不要解释、不要编号、不要引号。";

/**
 * 由章节内容合成一个**真实客户会问**的问题。
 *
 * 关键约束：问题必须能被**这一节**回答（否则消融后无法判断"答不了"是谁造成的），
 * 且措辞要像客户自己组织的语言（含口语化、不完整表述），而不是照抄章节标题——
 * 照抄标题会让检索过易，把负样本难度压低，重现"构造的负样本太容易"这个老问题。
 */
export function questionSynthesisPrompt(section: KbSection): string {
  return [
    "下面是一份客服知识库里的某一节内容。请模拟一个真实客户，写出他可能会问的一个问题。",
    "",
    "要求：",
    "1. 问题必须能且仅能由下面这一节回答；",
    "2. 用客户自己的口吻，可以口语化、可以省略主语，像真的在打字；",
    "3. 不要照抄章节标题里的词，换一种说法；",
    "4. 只输出问题本身，一行，不要任何前后缀。",
    "",
    `【章节标题】${section.heading}`,
    "【章节正文】",
    section.content,
  ].join("\n");
}

export const SynthesizedQuestionSchema = z.object({
  sectionId: z.string().min(1),
  question: z.string().min(1),
});
export type SynthesizedQuestion = z.infer<typeof SynthesizedQuestionSchema>;

/** 清洗模型输出：去引号、去编号、取第一行非空文本 */
export function parseSynthesizedQuestion(raw: string, sectionId: string): SynthesizedQuestion | null {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^\s*\d+[.、)]\s*/, "")
    .replace(/^["'「『]/, "")
    .replace(/["'」』]\s*$/, "")
    .replace(/^(问题|问)[:：]\s*/, "")
    .trim();

  // 明显不像问题（太短 / 太长 / 空）就丢弃，不硬凑
  if (cleaned.length < 4 || cleaned.length > 120) return null;
  return { sectionId, question: cleaned };
}

/**
 * 消融：从候选池里移除承载答案的那一节。
 *
 * 故意写成独立纯函数而不是内联——"消融到底有没有真的把那一节拿掉"是这套方法成立的前提，
 * 必须能被单独测到（漏掉它整批负样本就全变成错标的正类）。
 */
export function ablate(candidateIds: string[], removedId: string): string[] {
  return candidateIds.filter((id) => id !== removedId);
}

export interface SynthesisCheck {
  sectionId: string;
  question: string;
  /** 全库检索下源章节的排名（1 = 第一） */
  sourceRank: number | null;
  /** 是否排第一。排第一最干净：几乎可以断定问题由该节回答 */
  topOne: boolean;
  /** 排名是否在容忍范围内。超出则整条样本作废 */
  valid: boolean;
  reason: string;
}

export interface SynthesisCheckOptions {
  /**
   * 容忍的最大排名，默认 3。
   *
   * 为什么不要求必须排第一：知识库同一篇文档里的相邻章节常常互相竞争（问"价保周期"时
   * "价保范围"也高度相关），要求第一会把大量可用样本丢掉。排名靠前只保证
   * **问题确实落在这节的主题上**；这个节被拿掉之后答案是否真的不可得，
   * 由后续的作答探测来暴露（`answeredFromRemaining`），而不是靠这里卡死。
   */
  maxRank?: number;
}

/**
 * 验证合成的问题确实落在源章节的主题上。
 *
 * 这一步是消融法的前提：若问题与该节根本不相关，消融之后"答不了"就不是消融造成的，
 * 标签失去意义。但它只是**必要条件**，不是充分条件——相邻章节可能也含答案。
 */
export function checkSynthesis(
  sectionId: string,
  question: string,
  rankedSectionIds: string[],
  options: SynthesisCheckOptions = {},
): SynthesisCheck {
  const maxRank = options.maxRank ?? 3;
  const index = rankedSectionIds.indexOf(sectionId);
  const sourceRank = index < 0 ? null : index + 1;
  const topOne = sourceRank === 1;

  if (sourceRank !== null && sourceRank <= maxRank) {
    return {
      sectionId,
      question,
      sourceRank,
      topOne,
      valid: true,
      reason: topOne
        ? "全库检索下源章节排第一"
        : `全库检索下源章节排第 ${sourceRank}（容忍范围内），问题确实落在这节主题上`,
    };
  }
  return {
    sectionId,
    question,
    sourceRank,
    topOne: false,
    valid: false,
    reason:
      sourceRank === null
        ? "全库检索里没有源章节（检索结果异常）"
        : `全库检索下源章节只排第 ${sourceRank}（> ${maxRank}），问题与该节主题不符，消融后无法归因`,
  };
}

export interface ProbeCase {
  id: string;
  question: string;
  /** 被消融的章节（承载答案的那一节） */
  removedSectionId: string;
  /** 消融后剩下的候选章节 */
  remainingSectionIds: string[];
}

// ─────────────────────────────────────────────────────────────
// 残留度：消融到底有没有真的把答案拿掉（确定性检测，不引入模型判断）
// ─────────────────────────────────────────────────────────────

export interface AblationResidue {
  removedSectionId: string;
  /** 被消融章节里"在剩余内容中仍能找到出处"的句子占比 */
  residueShare: number;
  /** 仍然残留的句子示例 */
  residueSamples: string[];
  /** 被消融章节里被检查的句子数 */
  sentenceCount: number;
  /** 是否够格当一条有效负样本 */
  valid: boolean;
  reason: string;
}

export interface ResidueOptions {
  /** 字符 n-gram 长度，默认 6。中文下 6 字已足以指认一段表述 */
  ngram?: number;
  /** 单句有这么多比例的 n-gram 都能在剩余内容里找到，就算"这句还有出处"，默认 0.6 */
  sentenceMatchThreshold?: number;
  /** 残留句子占比低于它才算消融有效，默认 0.3 */
  maxResidueShare?: number;
  /** 短于该长度的句子不参与判断（太短容易假匹配） */
  minSentenceLength?: number;
}

const splitSentences = (text: string): string[] =>
  text
    .split(/[。！？；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function ngramSet(text: string, size: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= text.length; i += 1) out.add(text.slice(i, i + size));
  return out;
}

/**
 * 检测消融是否真的移除了答案。
 *
 * 为什么必须有这一步：知识库里的规则常常在**多处重复**（同一份文档的相邻章节、
 * 甚至跨文档各写一遍）。只按章节消融时，答案往往从别处照样拿得到——
 * 这种样本被当成"知识库答不了"的正类就是**错标**，会把决策带整个撑破，
 * 让人误得出"单阈值不可行"的结论。
 *
 * 检测手段是确定性的：把被消融章节拆句，看每句的字符 n-gram 有多少比例
 * 仍能在剩余内容里找到。**不调用模型**——用模型判断"答案还在不在"，
 * 等于把模型判断重新引回标签。
 */
export function measureAblationResidue(
  removedContent: string,
  remainingContents: string[],
  removedSectionId: string,
  options: ResidueOptions = {},
): AblationResidue {
  const ngram = options.ngram ?? 6;
  const sentenceMatchThreshold = options.sentenceMatchThreshold ?? 0.6;
  const maxResidueShare = options.maxResidueShare ?? 0.3;
  const minSentenceLength = options.minSentenceLength ?? 12;

  const remainingGrams = new Set<string>();
  for (const content of remainingContents) {
    for (const gram of ngramSet(content, ngram)) remainingGrams.add(gram);
  }

  const sentences = splitSentences(removedContent).filter(
    (s) => s.length >= minSentenceLength,
  );
  if (sentences.length === 0) {
    return {
      removedSectionId,
      residueShare: 0,
      residueSamples: [],
      sentenceCount: 0,
      valid: false,
      reason: "被消融章节没有足够长的句子可供判断，无法确认消融是否有效",
    };
  }

  const residueSamples: string[] = [];
  for (const sentence of sentences) {
    const grams = [...ngramSet(sentence, ngram)];
    if (grams.length === 0) continue;
    const hits = grams.filter((gram) => remainingGrams.has(gram)).length;
    if (hits / grams.length >= sentenceMatchThreshold) residueSamples.push(sentence);
  }

  const residueShare = Number((residueSamples.length / sentences.length).toFixed(4));
  const valid = residueShare <= maxResidueShare;
  return {
    removedSectionId,
    residueShare,
    residueSamples,
    sentenceCount: sentences.length,
    valid,
    reason: valid
      ? `被消融章节 ${sentences.length} 句里只有 ${residueSamples.length} 句在别处仍能找到出处` +
        `（残留 ${(residueShare * 100).toFixed(0)}%），消融有效`
      : `被消融章节 ${sentences.length} 句里有 ${residueSamples.length} 句在别处照样能找到出处` +
        `（残留 ${(residueShare * 100).toFixed(0)}% > ${(maxResidueShare * 100).toFixed(0)}%）——` +
        `知识库在别处重复写了同样的内容，消融没有真的移除答案，这条不能当负样本`,
  };
}

/**
 * 知识库的冗余画像：有多少比例的章节，其内容在**其余章节**里也能找到大部分。
 *
 * 这个数本身就是个该被看见的结论：冗余高意味着
 * ① 章节级消融造不出有效负样本；
 * ② 更要紧的是，一个问题即使"答案不在库里"，检索也总能捞到**写法相近的邻居**——
 *    这正是群像式幻觉的温床（`src/nodes/confidence.ts` 的 flock 判据针对的是它的表现形式，
 *    而根因在知识库的组织方式）。
 */
export interface RedundancyReport {
  sectionCount: number;
  redundantSections: number;
  redundantShare: number;
  items: Array<{ id: string; residueShare: number }>;
}

export function measureKbRedundancy(
  sections: Array<{ id: string; content: string }>,
  options: ResidueOptions = {},
): RedundancyReport {
  const items: Array<{ id: string; residueShare: number }> = [];
  for (const section of sections) {
    const others = sections.filter((s) => s.id !== section.id).map((s) => s.content);
    const residue = measureAblationResidue(section.content, others, section.id, options);
    items.push({ id: section.id, residueShare: residue.residueShare });
  }
  const redundant = items.filter((item) => item.residueShare > (options.maxResidueShare ?? 0.3));
  return {
    sectionCount: items.length,
    redundantSections: redundant.length,
    redundantShare:
      items.length === 0 ? 0 : Number((redundant.length / items.length).toFixed(4)),
    items: items.sort((a, b) => b.residueShare - a.residueShare),
  };
}

/** 由校验通过的合成问题构造消融样本 */
export function buildAblatedCases(
  checks: SynthesisCheck[],
  allSectionIds: string[],
): ProbeCase[] {
  const cases: ProbeCase[] = [];
  let index = 0;
  for (const check of checks) {
    if (!check.valid) continue;
    index += 1;
    cases.push({
      id: `abl-${String(index).padStart(3, "0")}`,
      question: check.question,
      removedSectionId: check.sectionId,
      remainingSectionIds: ablate(allSectionIds, check.sectionId),
    });
  }
  return cases;
}

/**
 * 从文本里抽出所有阿拉伯数字（含小数）。
 *
 * 刻意做得很粗：这里要做的是"答案里的数字在上下文里有没有出处"，
 * 宁可多抓（多抓只是让幻觉率估得保守一点），不要漏抓。
 * 已知会带进列表编号之类的噪声，已在提取前把行首编号剔掉。
 */
export function extractFigures(text: string): string[] {
  const withoutListMarkers = text.replace(/^[ \t]*\d+[.、)）][ \t]*/gm, " ");
  const out = new Set<string>();
  for (const match of withoutListMarkers.matchAll(/\d+(?:\.\d+)?/g)) out.add(match[0]);
  return [...out];
}

export interface AnswerProbe {
  /** 是否承认"知识库里没有依据"（措辞启发式判断，见下方说明） */
  admitsIgnorance: boolean;
  /** 命中的承认话术 */
  ignorancePhrases: string[];
  /**
   * 是否**给出了一段像样的回答**（= 没有承认不知道）。
   *
   * 这是本探针的**主指标**，比"有没有编数字"重要得多：知识库答不了、
   * 模型却给出了一段笃定的回答——无论里面有没有具体数字——用户读到的都是"有答案"。
   * 群像式幻觉完全可以是纯定性的（"这种情况可以退，直接联系客服就行"），
   * 只盯着数字会大面积漏掉。
   */
  producedAnswer: boolean;
  /** 答案里出现、上下文里找不到出处的数字 */
  ungroundedFigures: string[];
  /** 答案里出现的所有数字 */
  allFigures: string[];
  /** 是否给出了具体数字断言 */
  assertsSpecifics: boolean;
  /** 严格口径：给了无出处的具体数字，且没有承认不知道。即"编造得很具体" */
  misleadsStrict: boolean;
  /** 宽松口径：只要有无出处的数字就算。用于让结论不依赖承认话术那张表 */
  misleadsLoose: boolean;
}

/**
 * 承认不知道的话术表。
 *
 * ⚠️ 这是**启发式**，不是语义判断。所以 `summarizeProbe` 同时给出严格/宽松两个口径——
 * 宽松口径完全不依赖这张表，结论对表的选择不敏感时才值得采信。
 *
 * 踩过的坑：`GENERATE_PROMPT` 里明确要求模型「上下文未覆盖的内容，明确说
 * 『这个问题我需要进一步确认』」，而第一版表里**没有这条**——于是最常见的那句
 * 承认话语反而识别不出来，`admitsIgnorance` 被系统性低估，
 * 连带把"没承认"的比例抬高。**话术表必须对着生产 prompt 的实际措辞来写。**
 */
export const IGNORANCE_PHRASES: RegExp[] = [
  // 生产 prompt 指定的那句（必须放在最前，这是最常出现的一条）
  /需要进一步确认/,
  /进一步确认/,
  // 检索/知识库口径
  /没有找到/,
  /未找到/,
  /找不到/,
  /未查到/,
  /查不到/,
  /没有查到/,
  /暂未查到/,
  /没有相关(?:的)?(?:信息|内容|资料|说明|依据|规则)/,
  /知识库(?:里|中)?(?:没有|未收录|不含)/,
  /暂未收录/,
  /暂无(?:相关)?/,
  // 覆盖口径
  /未涵盖/,
  /没有涵盖/,
  /未涉及/,
  /没有涉及/,
  /未明确/,
  /没有明确/,
  /上下文中?未/,
  // 兜底与转交
  /无法确认/,
  /无法回答/,
  /不确定/,
  /不掌握/,
  /没有.{0,8}依据/,
  /请联系(?:人工|客服)/,
  /转人工/,
  /建议.{0,6}(?:人工|客服)/,
];

/** 用确定性规则判定一条作答是否构成"对模拟用户的误导" */
export function classifyAnswerProbe(answer: string, contextText: string): AnswerProbe {
  const ignorancePhrases = IGNORANCE_PHRASES.filter((pattern) => pattern.test(answer)).map(
    (pattern) => pattern.source,
  );
  const admitsIgnorance = ignorancePhrases.length > 0;

  const allFigures = extractFigures(answer);
  // 复用的两类提取器：金额 / 长数字（账号订单号）与承诺性百分比
  for (const figure of [...extractAccountNumbers(answer), ...extractCommitmentNumbers(answer)]) {
    if (!allFigures.includes(figure)) allFigures.push(figure);
  }
  const ungroundedFigures = allFigures.filter((figure) => !contextText.includes(figure));

  const assertsSpecifics = allFigures.length > 0;
  return {
    admitsIgnorance,
    ignorancePhrases,
    producedAnswer: !admitsIgnorance,
    ungroundedFigures,
    allFigures,
    assertsSpecifics,
    misleadsStrict: ungroundedFigures.length > 0 && !admitsIgnorance,
    misleadsLoose: ungroundedFigures.length > 0,
  };
}

export interface ProbeRow {
  id: string;
  question: string;
  removedSectionId: string;
  /** 消融后 rerank 的 topScore —— 这是"难负样本"在分数轴上的位置 */
  topScore: number;
  /** 被消融章节若仍在，它的原始 rerank 分数（用于说明消融是否真的击中了答案） */
  sourceScoreWhenPresent: number | null;
  probe: AnswerProbe;
  answer: string;
}

export interface ProbeSummary {
  total: number;
  admittedIgnorance: number;
  /**
   * **主指标**：知识库给不出答案、模型却没承认这一点，而是给出了一段回答。
   * 这就是"模拟用户会说'解决了'、而标签其实错了"的比例。
   */
  didNotAdmit: number;
  didNotAdmitRate: number;
  misledStrict: number;
  misledLoose: number;
  /** 率，分母是 total */
  misledStrictRate: number;
  misledLooseRate: number;
  admitsRate: number;
  /**
   * 被判"答对了"（给了数字且全部有出处）的条数——说明消融没击中答案，
   * 属于需要剔除的假负样本。
   */
  answeredFromRemaining: number;
}

export function summarizeProbe(rows: ProbeRow[]): ProbeSummary {
  const total = rows.length;
  const rate = (part: number) => (total === 0 ? 0 : Number((part / total).toFixed(4)));

  const admittedIgnorance = rows.filter((row) => row.probe.admitsIgnorance).length;
  const didNotAdmit = rows.filter((row) => row.probe.producedAnswer).length;
  const misledStrict = rows.filter((row) => row.probe.misleadsStrict).length;
  const misledLoose = rows.filter((row) => row.probe.misleadsLoose).length;
  // 答对了 = 给了具体数字、且全部有出处。这类样本的答案其实还在库里，消融没击中
  const answeredFromRemaining = rows.filter(
    (row) => row.probe.assertsSpecifics && row.probe.ungroundedFigures.length === 0,
  ).length;

  return {
    total,
    admittedIgnorance,
    didNotAdmit,
    didNotAdmitRate: rate(didNotAdmit),
    misledStrict,
    misledLoose,
    misledStrictRate: rate(misledStrict),
    misledLooseRate: rate(misledLoose),
    admitsRate: rate(admittedIgnorance),
    answeredFromRemaining,
  };
}

/**
 * 把难负样本的分数放到已知的决策带上，判断消融是否把带撑破。
 *
 * 这是消融实验最有用的产出：如果难负样本的分数大量落在 band 内或 band 之上，
 * 说明"生产里的负样本更难"不是猜测，而是能被测出来的事实——单阈值在真实分布下不可分。
 */
export interface BandPlacement {
  belowBand: number;
  insideBand: number;
  aboveBand: number;
  /** 高于 band.low 的样本 id —— 这些就是会把单阈值判决撑破的样本 */
  breakers: Array<{ id: string; topScore: number }>;
}

export function placeAgainstBand(
  rows: Array<{ id: string; topScore: number }>,
  band: { low: number; high: number },
): BandPlacement {
  const belowBand: number[] = [];
  const insideBand: number[] = [];
  const aboveBand: number[] = [];
  const breakers: Array<{ id: string; topScore: number }> = [];

  for (const row of rows) {
    if (row.topScore < band.low) belowBand.push(row.topScore);
    else if (row.topScore <= band.high) insideBand.push(row.topScore);
    else aboveBand.push(row.topScore);
    // 超过"最简单的正样本"就意味着单阈值一定会误伤或漏判
    if (row.topScore > band.low) breakers.push({ id: row.id, topScore: row.topScore });
  }

  return {
    belowBand: belowBand.length,
    insideBand: insideBand.length,
    aboveBand: aboveBand.length,
    breakers: [...breakers].sort((a, b) => b.topScore - a.topScore),
  };
}
