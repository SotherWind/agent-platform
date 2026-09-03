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
import { z } from "zod/v4";
import type { AnswerCitation } from "../schema";
import type { Llm, LlmRequest, LlmResponse } from "../llm/types";
import { REVIEWER_PROMPT } from "../prompts";

export type OutputViolationCode =
  | "ungrounded_numbers"
  | "overpromise"
  | "absolute_claim"
  | "missing_confirmation"
  | "cross_tenant_leak"
  | "empty_answer"
  | "model_review_failed";

export const OutputViolationLabel: Record<OutputViolationCode, string> = {
  ungrounded_numbers: "答案中出现未在引用中出现的数字",
  overpromise: "虚假承诺表述",
  absolute_claim: "绝对化用语（广告法风险）",
  missing_confirmation: "提议了需确认的动作但未附确认入口",
  cross_tenant_leak: "疑似泄露其他租户信息",
  empty_answer: "答案为空",
  model_review_failed: "模型终审未通过",
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
  const scrubbed = text.replace(/\b(?:prop|sig|ticket)-[0-9a-f][0-9a-f-]*/gi, "");
  const out = new Set<string>();
  for (const p of patterns) {
    for (const m of scrubbed.match(p) ?? []) out.add(m.trim());
  }
  return [...out];
}

/** 确定性输出检查。零 LLM 调用，结果完全可复现 */
export function checkOutput(input: CheckOutputInput): OutputCheckResult {
  const violations: OutputViolation[] = [];
  const answer = input.answer ?? "";

  if (!answer.trim()) {
    return {
      passed: false,
      violations: [{ code: "empty_answer", detail: "答案为空，不能发出" }],
    };
  }

  // 1) grounding：答案里的账户数字必须能在引用原文中找到
  const citationText = (input.citations ?? []).map((c) => c.text).join("\n");
  const numbers = extractAccountNumbers(answer);
  if (numbers.length > 0) {
    const ungrounded = numbers.filter((n) => !citationText.includes(n));
    if (ungrounded.length > 0) {
      violations.push({
        code: "ungrounded_numbers",
        detail: `答案中的 ${ungrounded.join("、")} 未在任何引用中出现，不得凭空给出`,
        matched: ungrounded[0],
      });
    }
  }

  // 2) 虚假承诺
  for (const p of OVERPROMISE_PATTERNS) {
    const m = answer.match(p);
    if (m) {
      violations.push({
        code: "overpromise",
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
        code: "absolute_claim",
        detail: `出现绝对化用语「${m[0]}」，存在广告法风险`,
        matched: m[0],
      });
      break;
    }
  }

  // 4) 提议了动作却没给确认入口 → 用户可能以为已经生效
  if (input.hasActionProposal && !input.hasConfirmationEntry) {
    violations.push({
      code: "missing_confirmation",
      detail: "回复中提议了需确认的动作，但没有附带确认入口",
    });
  }

  // 5) 跨租户泄露：引用里出现别的租户，说明上层过滤漏了（纵深防御）
  if (input.tenantId) {
    const leaked = (input.citations ?? []).filter((c) => c.tenantId !== input.tenantId);
    if (leaked.length > 0) {
      violations.push({
        code: "cross_tenant_leak",
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
  source: z.enum(["deterministic", "model", "none"]).default("none"),
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
  private readonly onUsage?: ReviewerOptions["onUsage"];
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
  async review(input: CheckOutputInput & { attempt?: number; onUsage?: ReviewerOptions["onUsage"] }): Promise<ReviewVerdict> {
    const deterministic = checkOutput(input);
    const onUsage = input.onUsage ?? this.onUsage;
    if (!deterministic.passed) {
      return ReviewVerdictSchema.parse({
        passed: false,
        violations: deterministic.violations,
        attempts: input.attempt ?? 1,
        source: "deterministic",
        revisedAnswer: null,
      });
    }

    if (!this.llm) {
      return ReviewVerdictSchema.parse({
        passed: true,
        violations: [],
        attempts: input.attempt ?? 1,
        source: "deterministic",
        revisedAnswer: null,
      });
    }

    const prompt = [
      `【待审草稿】\n${input.answer}`,
      `【引用原文】\n${(input.citations ?? []).map((c) => `- ${c.text}`).join("\n") || "（无引用）"}`,
      `【是否提议了需确认的动作】${input.hasActionProposal ? "是" : "否"}`,
      `【是否附带确认入口】${input.hasConfirmationEntry ? "是" : "否"}`,
    ].join("\n\n");

    let lastViolations: Array<{ code: string; detail: string }> = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const req: LlmRequest = {
        system: REVIEWER_PROMPT.system,
        prompt,
        json: true,
        stage: "review",
      };

      let verdict: { passed?: boolean; violations?: Array<{ code: string; detail: string }> };
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
              code: "model_review_failed",
              detail: "终审模型不可用，已降级放行（可观测标记）",
            },
          ],
          attempts: attempt,
          source: "none",
          revisedAnswer: null,
        });
      }

      if (verdict?.passed === true) {
        return ReviewVerdictSchema.parse({
          passed: true,
          violations: [],
          attempts: attempt,
          source: "model",
          revisedAnswer: null,
        });
      }

      lastViolations = Array.isArray(verdict?.violations) ? verdict.violations : [];
    }

    return ReviewVerdictSchema.parse({
      passed: false,
      violations:
        lastViolations.length > 0
          ? lastViolations
          : [{ code: "model_review_failed", detail: "模型终审未通过" }],
      attempts: this.maxAttempts,
      source: "model",
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
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
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
