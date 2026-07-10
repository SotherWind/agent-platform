import type { Document } from "@langchain/core/documents";
import type { MemorySaver } from "@langchain/langgraph";
import type { RetrievedChunk, RerankedChunk } from "./schema";
export type {
  RetrievedChunk,
  RerankedChunk,
  AnswerCitation,
  RetrieveContextToolInput,
} from "./schema";

export type { AgentGraphNode, State } from "./state";

export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  metadata: Record<string, any>;
}

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

export interface BuildGraphConfig {
  checkpointer?: MemorySaver;
  vectorStore?: VectorStoreType;
  reranker?: Reranker | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface RagBotInput {
  query: string;
  tenantId?: string;
  history: ChatMessage[];
}

export interface RagBotOutput {
  answer: string;
  sources: string[];
}

export interface CreateGraphOptions {
  checkpointer?: MemorySaver;
  vectorStore?: VectorStoreType;
  reranker?: Reranker | null;
}
