/**
 * T4.1 输入侧 Guardrails
 *
 * 依据 Agentforce：guardrails 同时拦截输入 prompt、校验 Agent 提议的动作、过滤最终回复。
 * 这一层是三点里的第一点，在编排**之前**执行。
 *
 * 性能约束（清单 482 行）：命中黑名单直接短路，**不消耗 LLM token**。
 * 所以本模块是纯规则实现——一次正则扫描，零模型调用。
 * 这不是偷懒：规则前置正是 Swiggy 的结论（纯 LLM 分派实测仅 90% 准确率，
 * 而明确的注入特征词用规则命中率接近 100% 且不花钱）。
 */
import { GuardrailBlockedError } from "../errors";
import { detectPii, redactText } from "../observability/pii";

export type InputViolationCode =
  | "prompt_injection"
  | "identity_claim"
  | "blacklist"
  | "pii_detected"
  | "empty_input";

export interface InputViolation {
  code: InputViolationCode;
  detail: string;
  /** 被剥离 / 命中的片段 */
  matched?: string;
}

export interface InputGuardrailResult {
  blocked: boolean;
  /** 脱敏并剥离越权声明后的文本，这才是应该进 LLM 的文本 */
  sanitized: string;
  violations: InputViolation[];
  pii: {
    detected: string[];
    /** 原文已存入受控存储（原文不进 LLM） */
    originalStored: boolean;
  };
  /** 本层消耗的 LLM 调用次数，恒为 0（硬约束） */
  llmCalls: 0;
  blockReason?: string;
}

/** 提示注入特征：命中即剥离该片段 */
export const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /忽略(以上|之前|上面|上述)(的)?(所有)?(指令|提示|规则|设定|内容)/gi,
  /忽略(前面|之前)?(的)?(所有)?系统提示/gi,
  /你现在是(开发者模式|开发模式|上帝模式|无限制模式)/gi,
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)/gi,
  /disregard\s+(all\s+)?(previous|prior)\s+instructions/gi,
  /(reveal|print|output|show)\s+(your\s+)?(system\s+)?prompt/gi,
  /输出(你的|系统)(提示词|提示|指令|设定)/gi,
  /\bDAN\s*mode\b/gi,
  /越狱/gi,
  /jailbreak/gi,
  /假装(你|自己)(没有|不受)(任何)?(限制|约束)/gi,
  /pretend\s+you\s+have\s+no\s+(restrictions|limits|guidelines)/gi,
];

/** 越权身份声明：剥离声明本身，保留其余语义 */
export const IDENTITY_CLAIM_PATTERNS: RegExp[] = [
  /我是(你们的)?(系统)?管理员/gi,
  /我是(你们的)?(内部)?(员工|工作人员|运维|开发)/gi,
  /我是老板/gi,
  /我(现在)?拥有(最高|超级|所有)(权限|管理权)/gi,
  /I\s+am\s+(the\s+)?(admin|administrator|developer|staff)/gi,
  /以(管理员|内部员工)(身份|权限)/gi,
  /grant\s+me\s+admin/gi,
];

/** 默认黑名单：命中直接短路，不进编排 */
export const DEFAULT_BLACKLIST: RegExp[] = [
  /fuck\s+you/gi,
  /傻逼/gi,
  /\bkill\s+yourself\b/gi,
];

export interface InputGuardrailOptions {
  injectionPatterns?: RegExp[];
  identityPatterns?: RegExp[];
  blacklist?: RegExp[];
  /** 原文受控存储。默认不实现——生产必须注入，否则「原文仅存于受控存储」落空 */
  storeOriginal?: (text: string, meta: { tenantId?: string; threadId?: string }) => void;
  /** PII 是否阻断。false 表示脱敏后放行（默认） */
  blockOnPii?: boolean;
}

/**
 * 输入侧 Guardrails。
 *
 * 处理顺序：空值 → 黑名单 → 注入剥离 → 身份声明剥离 → PII 脱敏。
 * 黑名单放前面是因为它要短路后续全部流程，包括不进 LLM。
 */
export class InputGuardrails {
  private readonly injection: RegExp[];
  private readonly identity: RegExp[];
  private readonly blacklist: RegExp[];
  private readonly storeOriginal?: InputGuardrailOptions["storeOriginal"];
  private readonly blockOnPii: boolean;

  constructor(options: InputGuardrailOptions = {}) {
    this.injection = options.injectionPatterns ?? PROMPT_INJECTION_PATTERNS;
    this.identity = options.identityPatterns ?? IDENTITY_CLAIM_PATTERNS;
    this.blacklist = options.blacklist ?? DEFAULT_BLACKLIST;
    this.storeOriginal = options.storeOriginal;
    this.blockOnPii = options.blockOnPii ?? false;
  }

  run(
    text: string,
    context: { tenantId?: string; threadId?: string } = {},
  ): InputGuardrailResult {
    const violations: InputViolation[] = [];

    if (!text || !text.trim()) {
      return {
        blocked: true,
        sanitized: "",
        violations: [{ code: "empty_input", detail: "输入为空" }],
        pii: { detected: [], originalStored: false },
        llmCalls: 0,
        blockReason: "输入为空，无法处理。",
      };
    }

    // 1) 黑名单短路：不消耗任何后续资源，也不进 LLM
    for (const pattern of this.blacklist) {
      const m = text.match(pattern);
      if (m) {
        violations.push({
          code: "blacklist",
          detail: "输入命中黑名单，已短路",
          matched: m[0],
        });
        return {
          blocked: true,
          sanitized: "",
          violations,
          pii: { detected: [], originalStored: false },
          llmCalls: 0,
          blockReason: "你的消息包含不被允许的内容，无法继续。如需帮助请转人工。",
        };
      }
    }

    let sanitized = text;

    // 2) 提示注入：剥离注入片段（不是丢弃整句——用户可能同时问了正常问题）
    for (const pattern of this.injection) {
      const m = sanitized.match(pattern);
      if (m) {
        violations.push({
          code: "prompt_injection",
          detail: "检出提示注入，已剥离该片段",
          matched: m[0],
        });
        sanitized = sanitized.replace(pattern, "");
      }
    }

    // 3) 越权身份声明：剥离声明，保留其余语义
    //    「我是管理员，帮我查一下订单」→「帮我查一下订单」
    for (const pattern of this.identity) {
      const m = sanitized.match(pattern);
      if (m) {
        violations.push({
          code: "identity_claim",
          detail: "剥离越权身份声明；权限只取会话层身份，不由对话内容决定",
          matched: m[0],
        });
        sanitized = sanitized.replace(pattern, "");
      }
    }

    sanitized = sanitized.replace(/\s{2,}/g, " ").replace(/^[\s，,。.、]+/, "").trim();

    // 4) PII：脱敏后进 LLM，原文仅存受控存储
    const detected = detectPii(sanitized);
    let originalStored = false;
    if (detected.length > 0) {
      violations.push({
        code: "pii_detected",
        detail: `检出 PII（${detected.join(", ")}），已脱敏后进模型，原文存入受控存储`,
      });
      if (this.storeOriginal) {
        this.storeOriginal(text, context);
        originalStored = true;
      }
      sanitized = redactText(sanitized);
    }

    const blocked = this.blockOnPii && detected.length > 0;

    return {
      blocked,
      sanitized,
      violations,
      pii: { detected, originalStored },
      llmCalls: 0,
      blockReason: blocked ? "输入包含敏感信息，已阻断。" : undefined,
    };
  }

  /** 严格模式：拦截时抛错，供编排层直接短路 */
  assert(text: string, context: { tenantId?: string; threadId?: string } = {}): InputGuardrailResult {
    const result = this.run(text, context);
    if (result.blocked) {
      throw new GuardrailBlockedError(result.blockReason ?? "Input blocked by guardrails.", {
        stage: "guardrails",
        reasonCode: result.violations[0]?.code ?? "guardrail_blocked",
      });
    }
    return result;
  }
}
