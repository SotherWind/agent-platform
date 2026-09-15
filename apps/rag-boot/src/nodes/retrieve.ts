/**
 * 检索链路节点：retrieve → rerank
 *
 * T2.3 加固的是既有能力：租户隔离已经在 `vectorstore.ts` 的 metadata filter 里做对，
 * 本节点的职责是**不把这件事弄坏**，并且让「fail-closed」无处可绕。
 *
 * T6.1 的两条降级也在这里落地：
 * - Rerank 服务不可用 → 退化为纯向量序，不阻断回答
 * - 向量库不可用 → 由调用方降级为纯 FAQ 直答（本节点抛错，上层兜底）
 */
import type {
  RetrievedChunk,
  RerankedChunk,
  VectorStoreType,
  Reranker,
  RetrievalScope,
} from "../type";
import { TenantMissingError } from "../errors";
import { matchesKnowledgeScope } from "../knowledge-scope";
import { isKnowledgeDocumentActive } from "../vectorstore";

export interface RetrieveInput {
  query: string;
  tenantId: string;
  topK?: number;
  topN?: number;
  scope?: RetrievalScope;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /** 降级标记：向量库不可用 */
  degraded: boolean;
  degradedReason: string | null;
}

/**
 * 向量检索。
 *
 * Fail-closed：缺 tenantId 直接拒绝。这条不能放宽成「缺省租户」——
 * 一旦有缺省值，「忘记传租户」就从报错变成静默跨租户读取。
 */
export async function retrieve(
  store: VectorStoreType | undefined,
  input: RetrieveInput,
): Promise<RetrieveResult> {
  if (!input.tenantId) {
    throw new TenantMissingError("tenantId is required. Retrieval rejected.");
  }

  const topK = input.topK ?? 20;

  if (!store) {
    return {
      chunks: [],
      degraded: true,
      degradedReason: "vector store unavailable",
    };
  }

  try {
    const candidates = await store.search(input.query, input.tenantId, topK, input.scope);
    const chunks = candidates.filter((chunk) => chunk.tenantId === input.tenantId &&
      matchesKnowledgeScope(chunk.metadata, input.scope) && isKnowledgeDocumentActive(chunk.metadata));
    return { chunks, degraded: false, degradedReason: null };
  } catch (err) {
    // 向量库故障：不抛给上层，返回空 + 降级标记。
    // 上层据此走 FAQ 直答或兜底——「系统在任何单点故障下仍有响应」（T6.1）。
    return {
      chunks: [],
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RerankResult {
  chunks: RerankedChunk[];
  /** true 表示 rerank 服务不可用，结果退化成了纯向量序 */
  degraded: boolean;
  degradedReason: string | null;
}

/**
 * 重排序。
 *
 * Rerank 不可用时退化为纯向量序：把 RetrievedChunk 补一个 rerankScore 继续走，
 * 而不是中断。检索质量下降，但回答不会消失。
 */
export async function rerank(
  reranker: Reranker | null | undefined,
  query: string,
  chunks: RetrievedChunk[],
  topN = 5,
): Promise<RerankResult> {
  if (chunks.length === 0) {
    return { chunks: [], degraded: false, degradedReason: null };
  }

  if (!reranker) {
    return {
      chunks: toVectorOrder(chunks, topN),
      degraded: true,
      degradedReason: "reranker not configured",
    };
  }

  try {
    const reranked = await reranker.rerank(query, chunks, topN);
    return { chunks: reranked, degraded: false, degradedReason: null };
  } catch (err) {
    return {
      chunks: toVectorOrder(chunks, topN),
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
    };
  }
}

function toVectorOrder(chunks: RetrievedChunk[], topN: number): RerankedChunk[] {
  return [...chunks]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((c) => ({ ...c, rerankScore: c.score }));
}

/**
 * T2.3 纵深防御：即便检索层已经按租户过滤，这里再筛一次。
 *
 * 刻意做成独立的纯函数，是为了让「检索层被绕过/返回脏数据」这个场景能被单测覆盖——
 * 单测里可以直接构造跨租户脏数据喂进来，断言 citations 里没有他租户内容。
 */
export function filterByTenant<T extends { tenantId: string }>(
  items: T[],
  tenantId: string,
): T[] {
  if (!tenantId) return [];
  return items.filter((item) => item.tenantId === tenantId);
}
