import type { Document } from "@langchain/core/documents";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RetrievedChunk, RerankedChunk } from "./schema";
import type { Llm, LlmTask } from "./llm/types";
import type { Prefilter } from "./prefilter";
import type { InputGuardrails } from "./guardrails/input";
import type { ActionGuardrails } from "./guardrails/action";
import type { Reviewer } from "./guardrails/output";
import type { AgentTool } from "./tools/contract";
import type { IdempotencyStore } from "./tools/idempotency";
import type { ActionSignalBus } from "./actions/signal";
import type { ProposalService } from "./actions/proposal";
import type { TicketService } from "./tickets";
import type { EscalationPolicyConfig } from "./escalation";
import type { Tracer } from "./observability/tracer";
export type {
  RetrievedChunk,
  RerankedChunk,
  AnswerCitation,
  RetrieveContextToolInput,
  TriageResult,
  SpecialistOutput,
  ToolCallRecord,
  BudgetUsage,
  InboundMessage,
  InboundAttachment,
} from "./schema";

export type { AgentGraphNode, State, StateUpdate } from "./state";

export type KnowledgeTimestamp = number;

export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  /** 业务版本；旧调用方可省略，入库时默认为 1。 */
  version?: string | number;
  /** Unix epoch milliseconds；缺省表示不限制生效起点。 */
  effectiveAt?: KnowledgeTimestamp;
  /** Unix epoch milliseconds；缺省表示永不过期。 */
  expiredAt?: KnowledgeTimestamp;
  metadata: Record<string, any>;
}

export interface KnowledgeChangeAuditEntry {
  action: "create" | "replace" | "delete";
  tenantId: string;
  documentId: string;
  version?: string | number;
  effectiveAt?: KnowledgeTimestamp;
  expiredAt?: KnowledgeTimestamp;
  chunkCount?: number;
  at: number;
}

export type KnowledgeChangeAuditSink = (
  entry: KnowledgeChangeAuditEntry,
) => void | Promise<void>;

/** 文档入库时的业务上下文 */
export interface IngestOptions {
  tenantId: string;
  documentId: string;
  source?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  /** true 时先删除同 documentId 的旧向量再写入，默认 true */
  replace?: boolean;
  /** .md 文件按 ## 标题切分（默认 true）；false 时用 RecursiveCharacterTextSplitter */
  splitBySection?: boolean;
  /** 文档生命周期元数据；未提供时保持兼容并表示不限制该边界。 */
  version?: string | number;
  effectiveAt?: KnowledgeTimestamp;
  expiredAt?: KnowledgeTimestamp;
}

/** VectorStore 实现类须满足的抽象类型 */
export type VectorStoreType = {
  search(
    query: string,
    tenantId: string,
    topK: number,
  ): Promise<RetrievedChunk[]>;
  addDocuments(docs: Document[], options: IngestOptions): Promise<number>;
  ingestFile(filePath: string, options: IngestOptions): Promise<number>;
  deleteByDocumentId(documentId: string, tenantId: string): Promise<void>;
};

export interface VectorStoreConfig {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  /** 知识写入 / 替换 / 删除后的审核记录接收器。 */
  onKnowledgeChange?: KnowledgeChangeAuditSink;
}

export interface Reranker {
  rerank(
    query: string,
    chunks: RetrievedChunk[],
    topN: number,
  ): Promise<RerankedChunk[]>;
}

export interface RerankApiResponse {
  results: Array<{ index: number; relevance_score: number }>;
}

export interface RerankerConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * checkpointer 接口。
 *
 * T0.4 的改动点：原来是 `MemorySaver | undefined`（进程内、重启即丢），
 * 现在放宽为 `BaseCheckpointSaver`，SQLite 实现才塞得进来。
 */
export type CheckpointerLike = BaseCheckpointSaver;

export interface BuildGraphConfig {
  /** 未传时默认使用 MemorySaver；生产可传 SqliteSaver。 */
  checkpointer?: CheckpointerLike;
  vectorStore?: VectorStoreType;
  /** null 表示明确关闭 rerank，并退化为向量排序；未传时也使用该安全默认。 */
  reranker?: Reranker | null;
  /** 各档 LLM（T6.2）。传数组即为该档的降级链（T6.1） */
  llms?: Partial<Record<"simple" | "small" | "large", Llm | Llm[]>>;
  /** 直接注入按任务路由后的 LLM，适合测试与自定义部署。 */
  llmRouter?: Partial<Record<LlmTask, Llm>>;
  /** 单会话最大工具调用轮次（T1.2） */
  maxToolTurns?: number;
  /** context token 预算（T2.2） */
  maxContextTokens?: number;
  maxChunks?: number;
  /** 置信度阈值（T2.4） */
  confidenceThreshold?: number;
  /** 单会话 token 预算（T6.3） */
  sessionTokenBudget?: number;
  /** 前置拦截（T9.3） */
  prefilter?: Prefilter;
  /** Guardrails（T4.1 / T4.2） */
  inputGuardrails?: InputGuardrails;
  actionGuardrails?: ActionGuardrails;
  /** 终审（T4.3） */
  reviewer?: Reviewer;
  /** 工具注册表（T3.1） */
  tools?: AgentTool[];
  idempotency?: IdempotencyStore;
  /** action signal 总线（T3.5） */
  signalBus?: ActionSignalBus;
  /** 三段分离服务（T5.3） */
  proposalService?: ProposalService;
  /** 工单服务（T5.4） */
  ticketService?: TicketService;
  /** 转人工策略（T5.1） */
  escalationPolicy?: EscalationPolicyConfig;
  /** tracing（T8.1） */
  tracer?: Tracer;
  clock?: () => number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface RagBotInput {
  query: string;
  /** 仅保留向后兼容；生产入口必须由 AccessGateway 注入身份。 */
  tenantId?: string;
  threadId?: string;
  principal?: string;
  /** 用户确认后回传的 proposal 令牌；公开入口仍需 authenticated=true。 */
  confirmationProposalId?: string;
  confirmationToken?: string;
  /** 已经由 AccessGateway 鉴权后的租户身份；直接调用图时缺失将 fail-closed。 */
  authenticated?: boolean;
  /**
   * ASR 渠道的转写置信度（0-1，T9.1）。
   * 低置信转写会拉低 T2.4 的整体置信度；非 ASR 渠道留空即可。
   */
  transcriptConfidence?: number | null;
  history: ChatMessage[];
}

export interface RagBotOutput {
  answer: string;
  sources: string[];
}

export interface CreateGraphOptions extends BuildGraphConfig {}
