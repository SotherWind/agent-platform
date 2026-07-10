import type { AccessPolicy } from "../policy/access-policy.js";
import type { SchemaDocument } from "./types.js";
import type { SchemaRetriever, SchemaSearchOptions } from "./retriever.js";
import {
  filterByPolicy,
  rankAndEnrichResults,
  scoreDocument,
} from "./retriever-scoring.js";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  hitsToDocuments,
  type VectorIndexBackend,
} from "./vector-backend.js";

export interface VectorSchemaRetrieverOptions {
  backend: VectorIndexBackend;
  embeddings: EmbeddingProvider;
  collectionAlias: string;
  /** 向量召回候选倍数，后续仍按关键词重排 */
  recallMultiplier?: number;
}

/** 基于向量索引的 SchemaRetriever，与 InMemory 共享 policy/scoring 语义 */
export class VectorSchemaRetriever implements SchemaRetriever {
  private readonly recallMultiplier: number;

  constructor(private readonly options: VectorSchemaRetrieverOptions) {
    this.recallMultiplier = options.recallMultiplier ?? 3;
  }

  async search(
    query: string,
    options: SchemaSearchOptions,
    policy?: AccessPolicy | null,
  ): Promise<SchemaDocument[]> {
    const limit = options.limit ?? 10;
    const recallLimit = Math.max(limit * this.recallMultiplier, limit);

    const [queryVector] = await this.options.embeddings.embed([query]);
    const hits = await this.options.backend.search(
      this.options.collectionAlias,
      queryVector!,
      {
        docType: options.docType,
        datasourceId: options.datasourceId,
        table: options.table,
        tables: options.tables,
        reviewStatus: options.reviewStatus ?? "approved",
        excludeDeleted: true,
      },
      recallLimit,
    );

    let candidates = hitsToDocuments(hits);
    candidates = filterByPolicy(candidates, policy);

    const keywordMatched = candidates.filter(
      (doc) => scoreDocument(query, doc) > 0,
    );

    return rankAndEnrichResults(
      query,
      keywordMatched,
      options,
      candidates,
    );
  }
}

/** 索引 demo 文档并返回 VectorSchemaRetriever（测试/本地 bootstrap 用） */
export async function createIndexedVectorRetriever(
  docs: SchemaDocument[],
  options?: {
    backend?: VectorIndexBackend;
    embeddings?: EmbeddingProvider;
    collectionAlias?: string;
  },
): Promise<{
  retriever: VectorSchemaRetriever;
  backend: VectorIndexBackend;
  alias: string;
}> {
  const { InMemoryVectorIndexBackend } = await import("./vector-backend.js");
  const { DeterministicEmbeddingProvider } = await import("./embeddings.js");
  const { SchemaIndexer } = await import("./indexer.js");

  const backend = options?.backend ?? new InMemoryVectorIndexBackend();
  const embeddings =
    options?.embeddings ?? new DeterministicEmbeddingProvider();
  const alias = options?.collectionAlias ?? "bi-metadata-active";

  const indexer = new SchemaIndexer({
    backend,
    embeddings,
    collectionAlias: alias,
  });
  await indexer.rebuildWithAliasSwap(docs);

  return {
    retriever: new VectorSchemaRetriever({
      backend,
      embeddings,
      collectionAlias: alias,
    }),
    backend,
    alias,
  };
}
