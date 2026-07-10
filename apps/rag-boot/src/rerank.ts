/**
 * 重排模块：调用兼容 Cohere 格式的 /rerank API，
 * 对向量检索结果按 query 相关性重新排序。
 */
import { config } from "dotenv";
import {
  RetrievedChunk,
  RerankedChunk,
  RerankApiResponse,
  RerankerConfig,
  Reranker,
} from "./type";

config();

const defaultBaseUrl = () =>
  process.env.RERANK_BASE_URL ?? "https://api.moark.com/v1";
const defaultModel = () => process.env.RERANK_MODEL ?? "Qwen3-Reranker-8B";

/** 通过 HTTP API 实现 Reranker 接口 */
export class ApiReranker implements Reranker {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: RerankerConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? defaultBaseUrl()).replace(/\/$/, "");
    this.model = config.model ?? defaultModel();
  }

  /**
   * 对 chunks 按与 query 的相关性重排，返回 topN 条并附带 rerankScore。
   * API 返回的 index 对应入参 documents 数组下标。
   */
  async rerank(
    query: string,
    chunks: RetrievedChunk[],
    topN: number = 10,
  ): Promise<RerankedChunk[]> {
    if (chunks.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: chunks.map((c) => c.content),
        top_n: Math.min(topN, chunks.length),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Rerank API error: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
      );
    }

    const data = (await response.json()) as RerankApiResponse;
    return data.results.map((r) => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  }
}

/** 从 .env 读取 RERANK_* 配置创建重排实例，支持 overrides 覆盖 */
export function createApiReranker(
  overrides: Partial<RerankerConfig> = {},
): ApiReranker {
  const apiKey = overrides.apiKey ?? process.env.RERANK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing rerank API key: set RERANK_API_KEY in .env or pass apiKey to createApiReranker()",
    );
  }
  return new ApiReranker({ ...overrides, apiKey });
}





