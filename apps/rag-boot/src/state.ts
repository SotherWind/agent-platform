/**
 * Agent 会话状态。
 *
 * 对应的 Swiggy 死因：迭代 2「RAG 无状态，多轮会话丢上下文」。
 * 所以这里除了检索链路，还带了多轮所需的计数器（turnCount / 连续低置信轮次 /
 * 连续兜底轮次 / 连续终审失败轮次）——T5.1 的转人工触发条件全部依赖这些计数，
 * 它们必须活在 checkpointer 里，不能活在进程内存里，否则重启即清零。
 */
import { StateSchema, MessagesValue, ReducedValue, GraphNode } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  AnswerCitationSchema,
  RerankedChunkSchema,
  RetrievedChunkSchema,
  TriageResultSchema,
  SpecialistOutputSchema,
  ToolCallRecordSchema,
  BudgetUsageSchema,
} from "./schema";
import { EscalationDecisionSchema, HandoffPackageSchema } from "./escalation";
import { ConfidenceDiagnosticsSchema } from "./confidence/profile";
import { ReviewVerdictSchema } from "./guardrails/output";
import { ActionProposalSchema } from "./actions/proposal";
import { ActionSignalSchema } from "./actions/signal";

/** 追加式字段：节点返回单条，reducer 负责 append */
const appendList = <T extends z.ZodType>(schema: T) =>
  new ReducedValue(z.array(schema).default(() => []), {
    inputSchema: schema,
    reducer: (current: Array<z.infer<T>>, next: z.infer<T>) => [...current, next],
  });

export const AgentState = new StateSchema({
  messages: MessagesValue,

  // ---- 身份（T9.2：tenantId 来自鉴权凭证，不由请求体决定） ----
  tenantId: z.string().default("").describe("租户标识，隔离知识库检索与引用范围"),
  threadId: z.string().default("").describe("会话线程 ID，checkpointer 的键"),
  principal: z.string().default("").describe("会话身份，写操作授权的唯一来源"),
  traceId: z.string().default("").describe("全链路 traceId，关联工单与 span"),
  operationId: z.string().default(""),
  completedOperationId: z.string().default(""),
  knowledgeScope: z.object({
    products: z.array(z.string()).default(() => []),
    regions: z.array(z.string()).default(() => []),
    roles: z.array(z.string()).default(() => []),
    permissions: z.array(z.string()).default(() => []),
  }).default(() => ({ products: [], regions: [], roles: [], permissions: [] })),
  /** T5.3 用户确认入口传回的 proposal 身份。 */
  confirmationProposalId: z.string().default(""),
  confirmationToken: z.string().default(""),

  // ---- 输入 ----
  query: z.string().default("").describe("用户问题原文"),
  /** T4.1 脱敏剥离后的文本，进 LLM 的是这个 */
  sanitizedQuery: z.string().default("").describe("输入侧 Guardrails 处理后的文本"),
  rewrittenQuery: z.string().default("").describe("T2.1 查询改写结果"),

  // ---- T9.1 ASR 转写置信度 → T2.4 整体置信度 ----
  /**
   * 本轮**入参**：渠道适配层从 ASR 附件带入（T9.1）。
   * turnStart 会把它固化进 asrTranscriptConfidence 并清空本字段，
   * 否则上一通电话的低转写置信度会泄漏到后续文本轮次里。
   */
  transcriptConfidence: z.number().nullable().default(null),
  /** 本轮**生效**的转写置信度；null 表示非 ASR 渠道或渠道未提供 */
  asrTranscriptConfidence: z.number().nullable().default(null),

  // ---- 检索链路 ----
  retrievedDocs: z.array(RetrievedChunkSchema).default(() => []),
  rerankedDocs: z.array(RerankedChunkSchema).default(() => []),
  /** T2.2 预算裁剪后真正进 prompt 的 chunk */
  contextChunks: z.array(RerankedChunkSchema).default(() => []),

  // ---- T2.4 置信度 ----
  confidence: z.number().nullable().default(null),
  lowConfidence: z.boolean().default(false),
  /**
   * 置信度判决诊断：阈值出处（profile 匹配/标定状态）、绝对覆盖度、区分度、群像标记。
   * 必须显式声明并声明默认值——zod 会把未声明的字段静默剥离（本项目踩过的坑）。
   */
  confidenceDiagnostics: ConfidenceDiagnosticsSchema.nullable().default(null),

  // ---- T1.1 分诊 ----
  triage: TriageResultSchema.nullable().default(null),
  route: z.enum(["pending", "direct", "specialist", "review", "escalate"]).default("pending"),

  // ---- T1.3 / T1.4 专家与编排 ----
  specialistOutputs: z.array(SpecialistOutputSchema).default(() => []),
  orchestratedAnswer: z.string().default(""),
  conflictResolved: z.array(z.string()).default(() => []),

  // ---- T1.2 / T3.3 工具 ----
  toolTurns: z.number().default(0),
  toolCalls: appendList(ToolCallRecordSchema),
  pendingToolRequests: z.array(z.record(z.string(), z.unknown())).default(() => []),
  /** 本轮是否已调用过工具（T3.3 强制取数的判定依据） */
  toolsCalledThisTurn: z.boolean().default(false),

  // ---- T5.3 / T3.5 动作 ----
  actionProposals: z.array(ActionProposalSchema).default(() => []),
  actionSignals: z.array(ActionSignalSchema).default(() => []),

  // ---- T6.3 预算 ----
  budget: BudgetUsageSchema.default(() => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    llmCalls: 0,
    toolTurns: 0,
    contextTokens: 0,
    savedTokens: 0,
  })),

  // ---- T6.1 降级 ----
  degradations: appendList(z.string()),

  // ---- 多轮计数器（T5.1 转人工触发条件） ----
  turnCount: z.number().default(0),
  consecutiveFallbackTurns: z.number().default(0),
  consecutiveLowConfidenceTurns: z.number().default(0),
  consecutiveReviewFailures: z.number().default(0),

  // ---- T5.1 情绪判定（negative_sentiment 触发的输入来源）----
  // 每轮由 turnStart 对 query 重新打分，因此天然不跨轮残留。
  sentiment: z.enum(["negative", "neutral", "positive"]).default("neutral"),
  sentimentIntensity: z.number().default(0),

  // ---- 输出 ----
  finalAnswer: z.string().default(""),
  citations: z.array(AnswerCitationSchema).default(() => []),
  review: ReviewVerdictSchema.nullable().default(null),

  // ---- T5.1 / T5.2 转人工 ----
  escalation: EscalationDecisionSchema.nullable().default(null),
  handoff: HandoffPackageSchema.nullable().default(null),
  ticketId: z.string().nullable().default(null),

  // ---- T9.3 前置拦截直答 ----
  prefilterHit: z.string().nullable().default(null),
  directAnswer: z.string().default(""),

  // ---- T1.2 终止 ----
  terminationReason: z.string().default(""),
});

export type AgentGraphNode = GraphNode<typeof AgentState>;

export type State = typeof AgentState.State;

export type StateUpdate = typeof AgentState.Update;
