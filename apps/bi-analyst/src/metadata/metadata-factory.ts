import type { SchemaRetriever } from "./retriever.js";
import type { SchemaIndexer } from "./indexer.js";
import { createEmbeddingProvider } from "./embedding-factory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { QdrantVectorIndexBackend } from "./qdrant-backend.js";
import { InMemoryVectorIndexBackend } from "./vector-backend.js";
import type { VectorIndexBackend } from "./vector-backend.js";
import { VectorSchemaRetriever } from "./vector-schema-retriever.js";
import { SchemaIndexer as SchemaIndexerImpl } from "./indexer.js";

export const DEFAULT_METADATA_ALIAS = "bi-metadata-active";

export interface MetadataStackOptions {
  qdrantUrl?: string;
  qdrantApiKey?: string;
  collectionAlias?: string;
  embeddingProvider?: EmbeddingProvider;
}

export interface MetadataStack {
  backend: VectorIndexBackend;
  embeddings: EmbeddingProvider;
  collectionAlias: string;
  retriever: SchemaRetriever;
  indexer: SchemaIndexer;
}

export function resolveMetadataAlias(env: NodeJS.ProcessEnv = process.env): string {
  return env.QDRANT_METADATA_ALIAS ?? DEFAULT_METADATA_ALIAS;
}

export function createVectorIndexBackend(
  options: MetadataStackOptions = {},
): VectorIndexBackend {
  const url =
    options.qdrantUrl !== undefined
      ? options.qdrantUrl
      : process.env.QDRANT_URL;
  if (url) {
    return new QdrantVectorIndexBackend({
      url,
      apiKey: options.qdrantApiKey ?? process.env.QDRANT_API_KEY,
    });
  }
  return new InMemoryVectorIndexBackend();
}

export function createMetadataStack(
  options: MetadataStackOptions = {},
): MetadataStack {
  const backend = createVectorIndexBackend(options);
  const embeddings =
    options.embeddingProvider ?? createEmbeddingProvider();
  const collectionAlias =
    options.collectionAlias ?? resolveMetadataAlias();

  const indexer = new SchemaIndexerImpl({
    backend,
    embeddings,
    collectionAlias,
  });

  const retriever = new VectorSchemaRetriever({
    backend,
    embeddings,
    collectionAlias,
  });

  return { backend, embeddings, collectionAlias, retriever, indexer };
}

/** 延迟初始化：保持 bootstrap 同步，首次 search 前完成索引 */
export class LazySchemaRetriever implements SchemaRetriever {
  private readonly ready: Promise<SchemaRetriever>;

  constructor(factory: () => Promise<SchemaRetriever>) {
    this.ready = factory();
  }

  async search(
    query: string,
    options: Parameters<SchemaRetriever["search"]>[1],
    policy?: Parameters<SchemaRetriever["search"]>[2],
  ) {
    const retriever = await this.ready;
    return retriever.search(query, options, policy);
  }
}

export function shouldUseVectorMetadata(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BI_METADATA_VECTOR === "1" || Boolean(env.QDRANT_URL);
}
