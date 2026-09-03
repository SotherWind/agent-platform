import { z } from "zod/v4";

export const RetrievedChunkSchema = z.object({
  id: z.string().describe("唯一标识"),
  documentId: z.string().describe("文档ID"),
  tenantId: z.string().describe("租户ID"),
  content: z.string().describe("chunk内容"),
  score: z.number().describe("相似性得分"),
  metadata: z.record(z.string(), z.unknown()).describe("元数据"),
});

export const RerankedChunkSchema = RetrievedChunkSchema.extend({
  rerankScore: z.number().describe("重排得分"),
});

export const AnswerCitationSchema = z.object({
  chunkId: z.string().describe("chunk ID"),
  documentId: z.string().describe("文档ID"),
  tenantId: z.string().describe("租户ID"),
  text: z.string().describe("引用原文"),
});

export const RetrieveContextToolInputSchema = z.object({
  query: z
    .string()
    .min(1, "query 不能为空")
    .describe("用户检索意图，用于向量相似度搜索"),
  tenantId: z
    .string()
    .min(1, "tenantId 不能为空")
    .describe("租户标识，检索时按此过滤，仅返回当前租户文档"),
  topK: z
    .number()
    .min(5, "topK 不能小于 5")
    .max(50, "topK 不能大于 50")
    .default(20)
    .describe("向量检索召回的候选 chunk 数量上限"),
  topN: z
    .number()
    .min(1, "topN 不能小于 1")
    .max(10, "topN 不能大于 10")
    .default(5)
    .describe("返回给调用方的 chunk 数量，须不大于 topK"),
}).refine((data) => data.topN <= data.topK, {
  message: "topN 不能大于 topK",
  path: ["topN"],
});

// ---------------------------------------------------------------------------
// T1.1 分诊
// ---------------------------------------------------------------------------

/** 支持多标签：一个工单常跨两个类别（Diffco 实测约 7%） */
export const TriageCategorySchema = z.enum([
  "billing",
  "integration",
  "account",
  "technical",
  "order",
  "general",
]);

export const TriageResultSchema = z.object({
  categories: z.array(TriageCategorySchema).catch([]).default(() => []),
  urgency: z.enum(["low", "normal", "high"]).catch("normal").default("normal"),
  likelyNeedsHuman: z.boolean().catch(false).default(false),
  needsRealtimeData: z.boolean().catch(false).default(false),
  /** 分诊来源：rule = 规则命中，model = 模型判定，fallback = 降级 */
  source: z.enum(["rule", "model", "fallback"]).default("model"),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

// ---------------------------------------------------------------------------
// T1.3 专家输出（结构化，不是自然语言段落）
// ---------------------------------------------------------------------------

export const ToolRequestSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default(() => ({})),
});

export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export const SpecialistOutputSchema = z.object({
  category: z.string(),
  status: z.enum(["resolved", "needsOrchestrator", "escalate"]),
  /** status=resolved 时的完整答案 */
  answer: z.string().default(""),
  /** 部分答案（needsOrchestrator 时给出） */
  partialAnswer: z.string().default(""),
  /** 还缺什么 */
  gap: z.string().default(""),
  /** escalate 时的原因 */
  reason: z.string().default(""),
  /** 本专家希望调用的工具（经工具清单校验后才可执行） */
  toolRequests: z.array(ToolRequestSchema).default(() => []),
  /** 越界被拒的工具请求（T1.3：代码拦截，不依赖模型自觉），带拒绝原因供审计与评测 */
  rejectedToolRequests: z
    .array(ToolRequestSchema.extend({ reason: z.string().default("") }))
    .default(() => []),
  citations: z.array(z.string()).default(() => []),
  promptVersion: z.string().default("v1"),
});

export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

// ---------------------------------------------------------------------------
// T3.3 工具调用记录（「上一轮结果不得复用」的判定依据）
// ---------------------------------------------------------------------------

export const ToolCallRecordSchema = z.object({
  name: z.string(),
  kind: z.enum(["read", "write"]),
  ok: z.boolean(),
  /** 幂等键 */
  idempotencyKey: z.string(),
  /** 是否命中幂等缓存 */
  deduped: z.boolean().default(false),
  /** 结果摘要，进交接包与 tracing */
  summary: z.string().default(""),
  /** 本会话第几轮产生的（T3.3 判定「是不是本轮数据」） */
  turnIndex: z.number(),
  at: z.number(),
  error: z.string().nullable().default(null),
});

export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

// ---------------------------------------------------------------------------
// T6.3 预算用量
// ---------------------------------------------------------------------------

export const BudgetUsageSchema = z.object({
  promptTokens: z.number().default(0),
  completionTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  llmCalls: z.number().default(0),
  toolTurns: z.number().default(0),
  /** 进入 prompt 的 context token 数（T2.2 要求可观测） */
  contextTokens: z.number().default(0),
  /** 直答节省的 token（T9.3） */
  savedTokens: z.number().default(0),
});

export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

// ---------------------------------------------------------------------------
// T9.1 归一化后的入站消息
// ---------------------------------------------------------------------------

export const AttachmentRouteSchema = z.enum(["multimodal", "knowledge_ingest", "asr", "reject"]);
type AttachmentRoute = z.infer<typeof AttachmentRouteSchema>;

export const InboundAttachmentSchema = z.object({
  type: z.enum(["image", "document", "audio", "video", "other"]),
  route: AttachmentRouteSchema.default("reject"),
  mimeType: z.string().default(""),
  url: z.string().default(""),
  /** 转写文本（ASR 渠道） */
  transcript: z.string().nullable().default(null),
  /** ASR 转写置信度：低置信要影响 T2.4 的整体置信度 */
  transcriptConfidence: z.number().nullable().default(null),
  sizeBytes: z.number().default(0),
});

export type InboundAttachment = z.infer<typeof InboundAttachmentSchema>;

export const InboundMessageSchema = z.object({
  /** 渠道来源 */
  channel: z.string(),
  /** 渠道侧消息 ID，入口幂等的键 */
  messageId: z.string(),
  tenantId: z.string(),
  threadId: z.string(),
  /** 会话身份（来自鉴权凭证，非请求体） */
  principal: z.string(),
  text: z.string(),
  attachments: z.array(InboundAttachmentSchema).default(() => []),
  /** 渠道差异化的扩展字段，全部吸收在适配层 */
  meta: z.record(z.string(), z.unknown()).default(() => ({})),
  /** 原始 payload：仅用于排障，绝不进 LLM 上下文 */
  rawPayload: z.record(z.string(), z.unknown()).nullable().default(null),
  receivedAt: z.number(),
});

export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;
export type RerankedChunk = z.infer<typeof RerankedChunkSchema>;
export type AnswerCitation = z.infer<typeof AnswerCitationSchema>;
export type RetrieveContextToolInput = z.infer<typeof RetrieveContextToolInputSchema>;
export type TriageCategory = z.infer<typeof TriageCategorySchema>;
