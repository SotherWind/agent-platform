/**
 * T4.3 输出侧 Guardrails + 终审 Reviewer
 *
 * 依据 Diffco 阶段 5：二次模型对照检查表校验，**不通过连同草稿进人工队列**。
 * 作者称大部分时间节省实际来自这里——人工是在编辑而不是从零开始。
 *
 * 两层设计：
 * 1. 确定性检查（本文件 `checkOutput`）：零成本、100% 可测，拦 grounding / 虚假承诺 / 广告法 / 确认入口
 * 2. 模型终审（`Reviewer`）：补确定性规则覆盖不到的语义问题（越权、语气、策略边界）
 *
 * 顺序是**先确定性后模型**：能被规则抓住的绝不多花一次模型调用，
 * 而且确定性失败直接短路，不用等模型。
 */
import { z } from 'zod/v4';
import type { AnswerCitation } from '../schema';
import type { Llm, LlmRequest, LlmResponse } from '../llm/types';
import { REVIEWER_PROMPT } from '../prompts';
import { subjectTerms } from '../confidence/coverage';

export type OutputViolationCode =
  | 'ungrounded_numbers'
  | 'ungrounded_claim'
  | 'missing_citation'
  | 'overpromise'
  | 'absolute_claim'
  | 'missing_confirmation'
  | 'cross_tenant_leak'
  | 'empty_answer'
  | 'model_review_failed';

export const OutputViolationLabel: Record<OutputViolationCode, string> = {
  ungrounded_numbers: '答案中出现未在引用中出现的数字',
  ungrounded_claim: '数字出现在引用里，但挂在另一件事上（跨主体借用）',
  missing_citation: '基于知识上下文作答却没有任何引用',
  overpromise: '虚假承诺表述',
  absolute_claim: '绝对化用语（广告法风险）',
  missing_confirmation: '提议了需确认的动作但未附确认入口',
  cross_tenant_leak: '疑似泄露其他租户信息',
  empty_answer: '答案为空',
  model_review_failed: '模型终审未通过',
};

/** 虚假承诺：承诺了一个客服系统无权保证的结果 */
export const OVERPROMISE_PATTERNS: RegExp[] = [
  /一定(能|会|可以)?/g,
  /保证/g,
  /百分百/g,
  /100%/g,
  /绝对(不|会|能)?/g,
  /永不/g,
  /无条件/g,
  /无论如何都/g,
  /包(你|您)满意/g,
];

/** 广告法风险：绝对化用语 */
export const ABSOLUTE_CLAIM_PATTERNS: RegExp[] = [
  /最好/g,
  /最佳/g,
  /第一(名|品牌)?/g,
  /唯一/g,
  /顶级/g,
  /国家级/g,
  /最(低|高)价/g,
  /首选/g,
  /极致/g,
];

export interface OutputViolation {
  code: OutputViolationCode;
  detail: string;
  matched?: string;
}

export interface OutputCheckResult {
  passed: boolean;
  violations: OutputViolation[];
}

export interface CheckOutputInput {
  answer: string;
  citations?: AnswerCitation[];
  /** 本轮是否提议了需确认的动作 */
  hasActionProposal?: boolean;
  /** 是否附带了确认入口（确认链接 / 按钮 / 令牌） */
  hasConfirmationEntry?: boolean;
  tenantId?: string;
  /**
   * 本轮是否有知识上下文（contextChunks 非空）。
   * 只有"带着检索上下文作答"时，缺引用才构成 fail-closed 违规；
   * 工具直答 / 预置 FAQ / 纯确认话术没有 citations，属正常路径。
   */
  hasKnowledgeContext?: boolean;
}

/**
 * 提取答案中的「账户类数字」——金额、订单号、长数字串。
 * 普通数量词（「3 个工作日」「5 分钟」）不算，否则规则会误伤正常的知识问答。
 */
export function extractAccountNumbers(text: string): string[] {
  const patterns = [
    // 金额：¥120.00 / 120 元 / $99.9
    /[¥$￥]\s?\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s?(?:元|块|块钱|美元)/g,
    // 订单号 / 账号：连续 8 位以上数字
    /(?<!\d)\d{8,}(?!\d)/g,
  ];
  // 系统自产单号（prop-<ts>-<seq> / sig-<hash> / ticket-<uuid>）不是账户数字：
  // 它们是本轮生成的确认入口与回执，其中的时间戳/哈希常含 8 位以上连续数字，
  // 不剥离的话确认话术会被 ungrounded_numbers 误杀，确认流程整个断掉。
  const scrubbed = text.replace(
    /\b(?:prop|sig|ticket)-[0-9a-f][0-9a-f-]*/gi,
    '',
  );
  const out = new Set<string>();
  for (const p of patterns) {
    for (const m of scrubbed.match(p) ?? []) out.add(m.trim());
  }
  return [...out];
}

/**
 * 提取「承诺性数字」——百分比及其中文写法。
 *
 * 为什么单列一类：`extractAccountNumbers` 只覆盖金额与 8 位以上账号/订单号，
 * 于是 `99.99%`、`99.9 %`、`百分之99.9` 这类**可用性 / 折扣承诺**完全落在 grounding 之外。
 * 而群像式幻觉最典型的产物恰恰就是这种"看起来很具体、其实无出处"的百分比承诺——
 * 检索全靠一簇勉强相关的 chunk 时，模型最容易补的就是一个漂亮的百分比。
 *
 * 返回的是**数字核心**（`99.99`）而不是整串（`99.99%`）：引用里常写成
 * "可用性 99.99" 或 "99.99 per cent"，按整串匹配会造成格式性误杀。
 * 这类误杀在本文件里已经有过一次教训（系统自产单号被 8 位数字规则误判，
 * 导致确认流程整个断掉，见上面 extractAccountNumbers 的 scrub 注释）。
 *
 * 已知不覆盖：`3 个 9` / `4 个 9` 这类写法需要归一化（"3 个 9" 的承诺强度不是数字 3），
 * 未纳入；裸的"承诺"字样属语气问题，交给 overpromise 规则与模型终审。
 */
export function extractCommitmentNumbers(text: string): string[] {
  const out = new Set<string>();
  // 99.99% / 99.9 % / 百分之99.99 / 百分之 99.99
  for (const m of text.match(/\d+(?:\.\d+)?\s?%|百分之\s?\d+(?:\.\d+)?/g) ??
    []) {
    const core = m.match(/\d+(?:\.\d+)?/)?.[0];
    if (core) out.add(core);
  }
  return [...out];
}

/** 按句切分（与 confidence/coverage.ts 同口径：中文口语的句子边界靠这些标点） */
const splitSentences = (text: string): string[] =>
  text
    .split(/[。！？；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * 时长数字：15 天 / 3 个工作日 / 24 小时。
 *
 * 注意它**不参与**规则 1 的"必须出现在引用里"硬校验——那是刻意排除的
 * （「3 个工作日」这类普通数量词大面积存在，硬查会误伤正常知识问答，
 * 见 extractAccountNumbers 的注释与 t43 的「普通数量词」测试）。
 * 它只进规则 1b 的主体一致性检查：时长确实在引用里出现过、
 * 但挂在另一件事上时（价保申请时限 → 退款到账时效），才判张冠李戴。
 */
export function extractDurationNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(
    /\d+(?:\.\d+)?\s*(?:个)?\s*(?:工作日|小时|分钟|天|日|个月|月|年)/g,
  ) ?? []) {
    out.add(m.replace(/\s+/g, ''));
  }
  return [...out];
}

/**
 * 答案里的「数字 → 所在句子」映射。
 * 一个数字可能出现在多句里，全部留着——只要有一句能证明主体一致就不算借用。
 * 按去空白匹配，容忍「15 天」与「15天」的写法差异。
 */
function sentencesWithNumber(answer: string, core: string): string[] {
  const needle = core.replace(/\s+/g, '');
  return splitSentences(answer).filter(
    (sentence) => sentence.replace(/\s+/g, '').indexOf(needle) >= 0,
  );
}

/**
 * 通用修饰词——不是主体，不能拿来证明"引用在讲同一件事"。
 * coverage.ts 的 STOP_TERMS 管的是问句里的属性词，这里管的是答案句里的泛化修饰，
 * 两类误杀/漏判的现场不同，但原则一致：泛词共现不构成主体一致。
 * （实测踩过：「退差价…15 天…」与引用「一般商品：…15 天内…」因共享「一般」而漏判。）
 */
const GENERIC_MODIFIERS = new Set([
  '一般',
  '通常',
  '正常',
  '默认',
  '基本',
  '目前',
  '需要',
  '可以',
  '可能',
  '应该',
  '将在',
  '之后',
  '以内',
]);

/**
 * 引用里含该数字的句子，是否存在一句与答案句**共享主体词**。
 *
 * 主体词直接复用 `coverage.ts` 的 `subjectTerms`（滑窗片段 + 停用词表）。
 * 复用它而不是另写一套：那套词表已经吸收过实测教训（比如 `怎么(?!样)` 的否定前瞻、
 * 只认「吗/么」不认问号），重写等于把踩过的坑再踩一遍。
 *
 * 两条防误杀的降级（coverage.ts 的教训：词法判据判不了就弃权，硬判会大面积误伤）：
 * - 数字片段与泛化修饰词不是主体词（"50"、"一般" 之类滑窗残留），过滤掉；
 * - 所有答案句都抽不出主体词 = 判不了，放行。
 */
function citationSupportsSubject(
  citationText: string,
  core: string,
  answerSentences: string[],
): boolean {
  const needle = core.replace(/\s+/g, '');
  const citationSentences = splitSentences(citationText).filter(
    (s) => s.replace(/\s+/g, '').indexOf(needle) >= 0,
  );
  if (citationSentences.length === 0) return true; // 数字在引用里但跨不了句（引用无边界），不判借用
  let judgeable = false;
  for (const answerSentence of answerSentences) {
    const terms = subjectTerms(answerSentence).filter(
      (term) => !/\d/.test(term) && !GENERIC_MODIFIERS.has(term),
    );
    if (terms.length === 0) continue;
    judgeable = true;
    if (citationSentences.some((cs) => terms.some((term) => cs.includes(term))))
      return true;
  }
  return !judgeable; // 全部判不了 → 放行；判得了但没有一句匹配 → 判借用
}

/** 确定性输出检查。零 LLM 调用，结果完全可复现 */
export function checkOutput(input: CheckOutputInput): OutputCheckResult {
  const violations: OutputViolation[] = [];
  const answer = input.answer ?? '';

  if (!answer.trim()) {
    return {
      passed: false,
      violations: [{ code: 'empty_answer', detail: '答案为空，不能发出' }],
    };
  }

  // 1) grounding：答案里的账户数字与承诺性数字必须能在引用原文中找到
  const citationText = (input.citations ?? []).map((c) => c.text).join('\n');
  const ungrounded = [
    ...new Set(
      [
        ...extractAccountNumbers(answer),
        ...extractCommitmentNumbers(answer),
      ].filter((n) => !citationText.includes(n)),
    ),
  ];
  if (ungrounded.length > 0) {
    violations.push({
      code: 'ungrounded_numbers',
      detail: `答案中的 ${ungrounded.join('、')} 未在任何引用中出现，不得凭空给出`,
      matched: ungrounded[0],
    });
  }

  // 1b) 跨主体借用：数字确实在引用里出现过，但引用讲的是**另一件事**。
  // 这是群像式幻觉最典型的产物——检索召回一堆「都差一点」的 chunk 时，模型最容易
  // 把 A 条款里的数字搬到 B 问题上（问「退差价多久到账」答 15 天，而 15 天是价保申请时限）。
  // 规则 1 只判「数字在不在引用里」，挡不住它，必须再看数字所在句的主体是否一致。
  // 候选集比规则 1 多了时长数字：规则 1 刻意不查时长（防大面积误伤），
  // 但"张冠李戴的时长"恰是知识问答最高发的幻觉形态，1b 的主体一致性检查足够宽容，
  // 判不了就弃权，不会像规则 1 那样硬查误杀。
  const citationTextCompact = citationText.replace(/\s+/g, '');
  const grounded = [
    ...new Set(
      [
        ...extractAccountNumbers(answer),
        ...extractCommitmentNumbers(answer),
        ...extractDurationNumbers(answer),
      ].filter((n) => citationTextCompact.includes(n.replace(/\s+/g, ''))),
    ),
  ];
  const borrowed = grounded.filter(
    (core) =>
      !citationSupportsSubject(
        citationText,
        core,
        sentencesWithNumber(answer, core),
      ),
  );
  if (borrowed.length > 0) {
    violations.push({
      code: 'ungrounded_claim',
      detail: `答案中的 ${borrowed.join('、')} 虽在引用中出现，但引用讲的是另一件事（主体不一致），不得张冠李戴`,
      matched: borrowed[0],
    });
  }

  // 1c) 引用接地 fail-closed：带着知识上下文作答却一条引用都没给。
  // 这是 coverage.ts 实测失败后指出的方向——不靠「判据」判答案对不对，
  // 而是要求「支撑它的那一句」必须在场，缺位即拦。群像幻觉骗得过任何分数分布检查，
  // 但骗不过「你说的那句话在 chunk 里找不到出处」。
  if (input.hasKnowledgeContext && (input.citations ?? []).length === 0) {
    violations.push({
      code: 'missing_citation',
      detail:
        '本轮有知识上下文却未给出任何引用，无法核对出处，fail-closed 拦截',
    });
  }

  // 2) 虚假承诺
  for (const p of OVERPROMISE_PATTERNS) {
    const m = answer.match(p);
    if (m) {
      violations.push({
        code: 'overpromise',
        detail: `出现虚假承诺表述「${m[0]}」，客服系统无权做此类保证`,
        matched: m[0],
      });
      break;
    }
  }

  // 3) 广告法绝对化用语
  for (const p of ABSOLUTE_CLAIM_PATTERNS) {
    const m = answer.match(p);
    if (m) {
      violations.push({
        code: 'absolute_claim',
        detail: `出现绝对化用语「${m[0]}」，存在广告法风险`,
        matched: m[0],
      });
      break;
    }
  }

  // 4) 提议了动作却没给确认入口 → 用户可能以为已经生效
  if (input.hasActionProposal && !input.hasConfirmationEntry) {
    violations.push({
      code: 'missing_confirmation',
      detail: '回复中提议了需确认的动作，但没有附带确认入口',
    });
  }

  // 5) 跨租户泄露：引用里出现别的租户，说明上层过滤漏了（纵深防御）
  if (input.tenantId) {
    const leaked = (input.citations ?? []).filter(
      (c) => c.tenantId !== input.tenantId,
    );
    if (leaked.length > 0) {
      violations.push({
        code: 'cross_tenant_leak',
        detail: `引用中出现 ${leaked.length} 条非本租户内容`,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

export const ReviewVerdictSchema = z.object({
  passed: z.boolean(),
  violations: z
    .array(z.object({ code: z.string(), detail: z.string() }))
    .default(() => []),
  /** 已尝试的终审次数 */
  attempts: z.number().default(0),
  /** 终审来源：deterministic = 规则拦下，model = 模型判定 */
  source: z.enum(['deterministic', 'model', 'none']).default('none'),
  /** 修订后的草稿（模型终审通过时可返回改写稿） */
  revisedAnswer: z.string().nullable().default(null),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export interface ReviewerOptions {
  llm?: Llm;
  onUsage?: (response: LlmResponse) => void;
  /** 最大终审轮次。达到上限仍不通过 → 带草稿转人工 */
  maxAttempts?: number;
  clock?: () => number;
}

/**
 * 终审 Reviewer。
 *
 * 关键行为（清单 507 行）：**不通过时携带草稿转人工，而不是直接丢弃**。
 * 所以 `review()` 的返回值里始终保留 `draft`，调用方拿它去建交接包（T5.2）。
 */
export class Reviewer {
  private readonly llm?: Llm;
  private readonly onUsage?: ReviewerOptions['onUsage'];
  private readonly maxAttempts: number;

  constructor(options: ReviewerOptions = {}) {
    this.llm = options.llm;
    this.onUsage = options.onUsage;
    this.maxAttempts = options.maxAttempts ?? 2;
    if (this.llm) {
      // 有模型时也要先跑确定性检查：规则能抓的就不花钱
    }
  }

  get attempts(): number {
    return this.maxAttempts;
  }

  /**
   * 终审。
   *
   * 流程：
   * 1. 确定性检查 → 不过直接返回（source=deterministic）
   * 2. 有模型则做语义终审（source=model）
   * 3. 无模型时，确定性检查通过即视为通过（降级：不能因为终审服务挂了就不回复）
   */
  async review(
    input: CheckOutputInput & {
      attempt?: number;
      onUsage?: ReviewerOptions['onUsage'];
    },
  ): Promise<ReviewVerdict> {
    const deterministic = checkOutput(input);
    const onUsage = input.onUsage ?? this.onUsage;
    if (!deterministic.passed) {
      return ReviewVerdictSchema.parse({
        passed: false,
        violations: deterministic.violations,
        attempts: input.attempt ?? 1,
        source: 'deterministic',
        revisedAnswer: null,
      });
    }

    if (!this.llm) {
      return ReviewVerdictSchema.parse({
        passed: true,
        violations: [],
        attempts: input.attempt ?? 1,
        source: 'deterministic',
        revisedAnswer: null,
      });
    }

    const prompt = [
      `【待审草稿】\n${input.answer}`,
      `【引用原文】\n${(input.citations ?? []).map((c) => `- ${c.text}`).join('\n') || '（无引用）'}`,
      `【是否提议了需确认的动作】${input.hasActionProposal ? '是' : '否'}`,
      `【是否附带确认入口】${input.hasConfirmationEntry ? '是' : '否'}`,
    ].join('\n\n');

    let lastViolations: Array<{ code: string; detail: string }> = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const req: LlmRequest = {
        system: REVIEWER_PROMPT.system,
        prompt,
        json: true,
        stage: 'review',
      };

      let verdict: {
        passed?: boolean;
        violations?: Array<{ code: string; detail: string }>;
      };
      try {
        const res = await this.llm.invoke(req);
        onUsage?.(res);
        verdict = parseJsonLoose(res.text) as typeof verdict;
      } catch {
        // 终审模型不可用：降级放行，但不能静默——记为 model_review_failed 供观测
        return ReviewVerdictSchema.parse({
          passed: true,
          violations: [
            {
              code: 'model_review_failed',
              detail: '终审模型不可用，已降级放行（可观测标记）',
            },
          ],
          attempts: attempt,
          source: 'none',
          revisedAnswer: null,
        });
      }

      if (verdict?.passed === true) {
        return ReviewVerdictSchema.parse({
          passed: true,
          violations: [],
          attempts: attempt,
          source: 'model',
          revisedAnswer: null,
        });
      }

      lastViolations = Array.isArray(verdict?.violations)
        ? verdict.violations
        : [];
    }

    return ReviewVerdictSchema.parse({
      passed: false,
      violations:
        lastViolations.length > 0
          ? lastViolations
          : [{ code: 'model_review_failed', detail: '模型终审未通过' }],
      attempts: this.maxAttempts,
      source: 'model',
      revisedAnswer: null,
    });
  }
}

/** 从模型输出里尽量抠出 JSON：兼容 ```json 代码块与前后废话 */
export function parseJsonLoose(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
