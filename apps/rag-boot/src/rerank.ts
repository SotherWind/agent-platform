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
    // 先验尺度再映射：越界分数意味着闸门的 floor/solid 全部失去意义（见 assertUnitScaleScores）
    assertUnitScaleScores(
      data.results.map((r) => r.relevance_score),
      { model: this.model, baseUrl: this.baseUrl },
    );
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

/**
 * 尺度守卫：rerank 分数必须落在 [0,1]。
 *
 * 为什么值得在运行期硬拦一次：整个置信度闸门都建立在 **sigmoid 归一化后的 [0,1]**
 * 尺度上——`floor=0.35`、`solid=0.55`、以及所有 profile 都是。而不同供应商对同一个
 * rerank 模型可能返回**原始 logit**（可到 ±10）。
 *
 * 这种错位的危险之处在于它**不报错**：分数全都在 0.35 以上 → `topScore < floor`
 * 永远不成立 → `lowConfidence` 恒为 false → **闸门彻底停止转人工**，而日志里一切正常。
 * 也就是说它会把一个安全机制静默关掉。宁可在这里响亮地失败（fail-closed）。
 *
 * 顺带一提，"分数没落在 [0,1]" 也是判断供应商是否换过尺度的最快信号，
 * 比事后对着兜底率曲线猜要可靠得多。
 */
export function assertUnitScaleScores(
  scores: number[],
  context: { model: string; baseUrl: string },
): void {
  if (scores.length === 0) return;
  const outliers = scores.filter((score) => !Number.isFinite(score) || score < 0 || score > 1);
  if (outliers.length === 0) return;

  throw new Error(
    `Rerank 分数不在 [0,1] 尺度上（模型 ${context.model} @ ${context.baseUrl}）：` +
      `共 ${outliers.length}/${scores.length} 个越界值，例如 ${outliers.slice(0, 3).join("、")}。` +
      `最可能的原因是这家供应商返回的是**原始 logit** 而不是 sigmoid 归一化分数。` +
      `置信度闸门的 floor/solid 与全部 profile 都标定在 [0,1] 上，` +
      `若放任不管，所有分数都会高于 floor，lowConfidence 恒为 false，闸门会**静默停止转人工**。` +
      `处理办法：换成与标定同尺度的模型/供应商，或先跑 pnpm verify:provider 确认尺度并重新标定。`,
  );
}





