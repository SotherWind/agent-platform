/**
 * T5.1 转人工触发条件 + T5.2 交接包
 *
 * T5.1 依据中文材料的具体触发条件 + Diffco 的分诊门控。
 * T5.2 依据 Diffco：升级的工单带完整 transcript、结构化账户上下文、已写好的草稿；
 * 人工是在**编辑**而非从零开始——作者称大部分时间节省实际来自这里，
 * 即使没能自动化的工单也快了 4 倍。
 */
import { z } from "zod/v4";
import type { AnswerCitation, RerankedChunk } from "./schema";
import { redactForClearance, redactObject, type AgentClearance } from "./observability/pii";

export const EscalationTriggerSchema = z.enum([
  /** 用户明确要求 */
  "user_request",
  /** 连续两次触发兜底话术 */
  "repeated_fallback",
  /** 情绪极度负面 */
  "negative_sentiment",
  /** Reviewer 连续不通过 */
  "reviewer_rejected",
  /** triage 判定 likelyNeedsHuman */
  "triage_likely_needs_human",
  /** 连续两轮低置信度（T2.4 联动） */
  "low_confidence_repeat",
  /** 高紧急度 */
  "high_urgency",
  /** 预算超限（T6.3） */
  "budget_exceeded",
  /** 全部模型不可用（T6.1） */
  "all_models_failed",
  /** Reviewer 判定越权 / 高风险 */
  "policy_violation",
]);

export type EscalationTrigger = z.infer<typeof EscalationTriggerSchema>;

export const ESCALATION_TRIGGER_LABEL: Record<EscalationTrigger, string> = {
  user_request: "用户明确要求转人工",
  repeated_fallback: "连续两次触发兜底话术",
  negative_sentiment: "情绪判定为极度负面",
  reviewer_rejected: "终审连续不通过",
  triage_likely_needs_human: "分诊判定可能需要人工",
  low_confidence_repeat: "连续两轮检索置信度低于阈值",
  high_urgency: "工单紧急度为高",
  budget_exceeded: "会话预算超限",
  all_models_failed: "全部模型不可用",
  policy_violation: "回复越出策略边界",
};

export const EscalationDecisionSchema = z.object({
  required: z.boolean(),
  triggers: z.array(EscalationTriggerSchema).default(() => []),
  /** 人类可读的原因，进交接包与坐席界面 */
  reasons: z.array(z.string()).default(() => []),
});

export type EscalationDecision = z.infer<typeof EscalationDecisionSchema>;

/** 触发条件所需的会话信号。刻意做成扁平结构，便于单测直接构造 */
export interface EscalationSignals {
  /** 用户本轮是否明确要求转人工 */
  userAskedForHuman?: boolean;
  /** 已连续多少轮输出兜底话术 */
  consecutiveFallbackTurns?: number;
  /** 情绪极性：negative | neutral | positive */
  sentiment?: "negative" | "neutral" | "positive";
  /** 情绪强度 0-1，超过阈值才算「极度负面」 */
  sentimentIntensity?: number;
  /** Reviewer 连续不通过次数 */
  consecutiveReviewFailures?: number;
  /** triage 判定结果 */
  triageLikelyNeedsHuman?: boolean;
  triageUrgency?: "low" | "normal" | "high";
  /** 连续低置信度轮次（T2.4） */
  consecutiveLowConfidenceTurns?: number;
  budgetExceeded?: boolean;
  allModelsFailed?: boolean;
  policyViolation?: boolean;
}

export interface EscalationPolicyConfig {
  maxConsecutiveFallbackTurns?: number;
  maxConsecutiveReviewFailures?: number;
  maxConsecutiveLowConfidenceTurns?: number;
  sentimentIntensityThreshold?: number;
}

/**
 * 转人工策略：纯函数式判定，同样输入必然同样输出（可回放、可评测）。
 */
export function evaluateEscalation(
  signals: EscalationSignals,
  config: EscalationPolicyConfig = {},
): EscalationDecision {
  const maxFallback = config.maxConsecutiveFallbackTurns ?? 2;
  const maxReview = config.maxConsecutiveReviewFailures ?? 2;
  const maxLowConf = config.maxConsecutiveLowConfidenceTurns ?? 2;
  const sentimentThreshold = config.sentimentIntensityThreshold ?? 0.8;

  const triggers: EscalationTrigger[] = [];
  const reasons: string[] = [];

  const hit = (t: EscalationTrigger) => {
    triggers.push(t);
    reasons.push(ESCALATION_TRIGGER_LABEL[t]);
  };

  if (signals.userAskedForHuman) hit("user_request");
  if ((signals.consecutiveFallbackTurns ?? 0) >= maxFallback) hit("repeated_fallback");
  if (
    signals.sentiment === "negative" &&
    (signals.sentimentIntensity ?? 0) >= sentimentThreshold
  ) {
    hit("negative_sentiment");
  }
  if ((signals.consecutiveReviewFailures ?? 0) >= maxReview) hit("reviewer_rejected");
  if (signals.triageLikelyNeedsHuman) hit("triage_likely_needs_human");
  if (signals.triageUrgency === "high") hit("high_urgency");
  if ((signals.consecutiveLowConfidenceTurns ?? 0) >= maxLowConf) {
    hit("low_confidence_repeat");
  }
  if (signals.budgetExceeded) hit("budget_exceeded");
  if (signals.allModelsFailed) hit("all_models_failed");
  if (signals.policyViolation) hit("policy_violation");

  return { required: triggers.length > 0, triggers, reasons };
}

/** 关键词规则：命中即视为用户要求人工，不经模型（对应 Swiggy 规则路由） */
export const HUMAN_REQUEST_PATTERNS = [
  /转人工/i,
  /人工客服/i,
  /找(个)?人工/i,
  /真人(客服)?/i,
  /我要投诉/i,
  /投诉(你|你们|贵)/i,
  /客服经理/i,
  /领导(在吗|在哪)/i,
];

export function isHumanRequest(text: string): boolean {
  return HUMAN_REQUEST_PATTERNS.some((r) => r.test(text));
}

export const TranscriptEntrySchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  at: z.number(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const HandoffPackageSchema = z.object({
  threadId: z.string(),
  tenantId: z.string(),
  /** 完整会话 transcript */
  transcript: z.array(TranscriptEntrySchema),
  /** 结构化账户上下文（T9.1 阶段 1 产出的紧凑账户对象） */
  accountContext: z.record(z.string(), z.unknown()),
  /** 已调用工具的结果 */
  toolResults: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      ok: z.boolean(),
      summary: z.string(),
      at: z.number(),
    }),
  ),
  /** Agent 已生成的草稿回复——人工是在编辑，不是从零写 */
  draftReply: z.string(),
  /** 升级原因与触发条件 */
  triggers: z.array(EscalationTriggerSchema),
  reasons: z.array(z.string()),
  citations: z.array(z.custom<AnswerCitation>()),
  /** 检索到的上下文摘要，供坐席快速判断是否知识缺失 */
  retrievedContext: z
    .array(
      z.object({
        chunkId: z.string(),
        documentId: z.string(),
        score: z.number(),
        excerpt: z.string(),
      }),
    )
    .default(() => []),
  confidence: z.number().nullable().default(null),
  /** PII 已按坐席权限脱敏 */
  piiRedacted: z.boolean().default(true),
  clearance: z.enum(["none", "masked", "full"]).default("masked"),
  createdAt: z.number(),
});

export type HandoffPackage = z.infer<typeof HandoffPackageSchema>;

export interface BuildHandoffInput {
  threadId: string;
  tenantId: string;
  transcript: TranscriptEntry[];
  accountContext?: Record<string, unknown>;
  toolResults?: Array<{
    name: string;
    kind: string;
    ok: boolean;
    summary: string;
    at: number;
  }>;
  draftReply: string;
  decision: EscalationDecision;
  citations?: AnswerCitation[];
  retrievedContext?: RerankedChunk[];
  confidence?: number | null;
  /** 坐席权限决定脱敏强度 */
  clearance?: AgentClearance;
  clock?: () => number;
}

/**
 * 构建交接包。
 *
 * PII 按坐席权限脱敏，但 transcript 的**结构**（角色、顺序、时间戳）完整保留——
 * 这是「脱敏不破坏排障所需结构信息」的落点（T8.2）。
 */
export function buildHandoffPackage(input: BuildHandoffInput): HandoffPackage {
  const clearance = input.clearance ?? "masked";
  const now = (input.clock ?? Date.now)();

  const transcript = input.transcript.map((entry) => ({
    role: entry.role,
    content: redactForClearance(entry.content, clearance),
    at: entry.at,
  }));

  const retrievedContext = (input.retrievedContext ?? []).map((chunk) => ({
    chunkId: chunk.id,
    documentId: chunk.documentId,
    score: chunk.rerankScore ?? chunk.score,
    excerpt: redactForClearance(chunk.content.slice(0, 200), clearance),
  }));

  return HandoffPackageSchema.parse({
    threadId: input.threadId,
    tenantId: input.tenantId,
    transcript,
    accountContext: redactObject(input.accountContext ?? {}),
    toolResults: input.toolResults ?? [],
    draftReply: redactForClearance(input.draftReply, clearance),
    triggers: input.decision.triggers,
    reasons: input.decision.reasons,
    citations: input.citations ?? [],
    retrievedContext,
    confidence: input.confidence ?? null,
    piiRedacted: clearance !== "full",
    clearance,
    createdAt: now,
  });
}
