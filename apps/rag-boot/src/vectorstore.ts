/**
 * 向量库模块：基于 @langchain/qdrant，直接消费 LangChain Document 流水线，
 * 支持文件入库、按 documentId 替换、按 tenantId 检索。
 *
 * 数据流：
 *   ingestFile → 切分 Document → enrich metadata → 分批 embedding → 写入 Qdrant
 *   search     → embedding query → 相似度检索（tenant 过滤）→ RetrievedChunk[]
 */
import { QdrantVectorStore as LangchainQdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import type {
  RetrievedChunk,
  VectorStoreConfig,
  IngestOptions,
  VectorStoreType,
} from "./type";
import { createEmbeddings } from "./embeddings";

/** 默认 chunk 字符数（与 RecursiveCharacterTextSplitter 一致） */
const DEFAULT_CHUNK_SIZE = 500;
/** 相邻 chunk 重叠字符数，避免语义在切分边界断裂 */
const DEFAULT_CHUNK_OVERLAP = 50;

/** 合并 overrides 与 .env，得到 Qdrant 连接配置 */
function resolveConfig(
  overrides: Partial<VectorStoreConfig> = {},
): Required<VectorStoreConfig> {
  return {
    url: overrides.url ?? process.env.QDRANT_URL ?? "http://localhost:6333",
    apiKey: overrides.apiKey ?? process.env.QDRANT_API_KEY ?? "",
    collectionName:
      overrides.collectionName ??
      process.env.QDRANT_COLLECTION_NAME ??
      "rag_boot",
  };
}

/**
 * 写入 Qdrant 前补充业务 metadata。
 * LangChain 会把 metadata 原样存入 payload，检索时用于多租户 / 多文档隔离。
 */
function enrichDocuments(docs: Document[], options: IngestOptions): Document[] {
  const source = options.source;
  return docs.map(
    (doc, index) =>
      new Document({
        pageContent: doc.pageContent,
        metadata: {
          ...doc.metadata,
          // 稳定 id，便于删除、引用与调试（documentId-序号）
          id: `${options.documentId}-${index + 1}`,
          documentId: options.documentId,
          tenantId: options.tenantId,
          source: source ?? doc.metadata?.source,
        },
      }),
  );
}

/** LangChain Document → 对外暴露的检索结果结构 */
function toRetrievedChunk(doc: Document, score: number): RetrievedChunk {
  const { id, documentId, tenantId, ...metadata } = doc.metadata;
  return {
    id: String(id),
    documentId: String(documentId),
    tenantId: String(tenantId),
    content: doc.pageContent,
    score,
    // section、sectionChunk 等切分元数据保留在 metadata 里
    metadata,
  };
}

/** Qdrant 过滤：只检索指定租户的数据 */
function tenantFilter(tenantId: string) {
  return {
    must: [{ key: "metadata.tenantId", match: { value: tenantId } }],
  };
}

/** Qdrant 过滤：删除 / 定位某个租户下的单个文档 */
function documentFilter(documentId: string, tenantId: string) {
  return {
    must: [
      { key: "metadata.tenantId", match: { value: tenantId } },
      { key: "metadata.documentId", match: { value: documentId } },
    ],
  };
}

/** 单次 upsert 的 chunk 数上限，避免请求体过大导致 fetch failed */
const INGEST_BATCH_SIZE = 32;

/** 统计 Markdown 某一级标题（# 重复次数）的出现次数 */
function countMarkdownHeadings(content: string, level: number): number {
  const re = new RegExp(`^${"#".repeat(level)}\\s+`, "gm");
  return (content.match(re) ?? []).length;
}

/**
 * 按 Markdown 标题切分章节（语义边界优先于字数切分）。
 *
 * 策略（自动判断文档结构）：
 * - `#` 多且多于 `##` → 一级标题文档（如编码规范），每节独立成块
 * - `##` ≥ 2           → 二级标题文档（如制度手册），文首引言拼进各节
 * - 否则               → 整篇作为「全文」
 */
function splitMarkdownSections(
  content: string,
): Array<{ content: string; section: string }> {
  const h1Count = countMarkdownHeadings(content, 1);
  const h2Count = countMarkdownHeadings(content, 2);

  if (h1Count >= 3 && h1Count > h2Count) {
    return splitByHeadingLevel(content, 1, { prependIntro: false });
  }
  if (h2Count >= 2) {
    return splitByHeadingLevel(content, 2, { prependIntro: true });
  }
  if (h1Count >= 2) {
    return splitByHeadingLevel(content, 1, { prependIntro: false });
  }

  return [{ content, section: "全文" }];
}

/**
 * 按指定标题级别切分。
 * @param prependIntro true 时：第一个标题块视为「文首引言」，拼接到后续每个章节前（保留手册标题上下文）
 */
function splitByHeadingLevel(
  content: string,
  level: number,
  opts: { prependIntro: boolean },
): Array<{ content: string; section: string }> {
  const marker = `${"#".repeat(level)} `;
  const parts = content
    .split(new RegExp(`\\n(?=${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`))
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return [{ content, section: "全文" }];
  }

  const headingRe = new RegExp(`^${"#".repeat(level)}\\s+(.+)`);

  if (opts.prependIntro) {
    const [titleBlock, ...sections] = parts;
    return sections.map((section) => ({
      content: `${titleBlock}\n\n${section}`.trim(),
      section: section.match(headingRe)?.[1]?.trim() ?? "未命名章节",
    }));
  }

  return parts.map((part) => ({
    content: part,
    section: part.match(/^#\s+(.+)/)?.[1]?.trim() ?? "未命名章节",
  }));
}

/**
 * 章节过长时按 chunkSize 二次切分，保留 section 元数据。
 * sectionChunk / sectionChunks 标记同一章节内的第几块，便于评测与展示。
 */
async function splitLongSections(
  sections: Array<{ content: string; section: string }>,
  baseMetadata: Record<string, unknown>,
  chunkSize: number,
  chunkOverlap: number,
): Promise<Document[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
  const result: Document[] = [];

  for (const { content, section } of sections) {
    if (content.length <= chunkSize) {
      result.push(
        new Document({
          pageContent: content,
          metadata: { ...baseMetadata, section, sectionChunk: 1, sectionChunks: 1 },
        }),
      );
      continue;
    }

    const subDocs = await splitter.createDocuments([content]);
    subDocs.forEach((doc, index) => {
      result.push(
        new Document({
          pageContent: doc.pageContent,
          metadata: {
            ...baseMetadata,
            section,
            sectionChunk: index + 1,
            sectionChunks: subDocs.length,
          },
        }),
      );
    });
  }

  return result;
}

/**
 * 文件切分入口。
 * - .md 且 splitBySection !== false：先按标题切章节，再按字数二次切
 * - 其他：整篇 RecursiveCharacterTextSplitter（适合无章节结构的纯文本）
 */
async function splitDocuments(
  filePath: string,
  docs: Document[],
  options: IngestOptions,
): Promise<Document[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const useMarkdownSections =
    options.splitBySection !== false && filePath.endsWith(".md");

  if (useMarkdownSections) {
    const sections = splitMarkdownSections(docs[0]?.pageContent ?? "");
    return splitLongSections(
      sections,
      docs[0]?.metadata ?? {},
      chunkSize,
      chunkOverlap,
    );
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
  return splitter.splitDocuments(docs);
}

/**
 * 读取 Qdrant collection 的向量维度。
 * 兼容单向量配置（vectors.size）与命名向量配置（vectors.default.size）。
 */
function readCollectionVectorSize(collection: {
  config?: { params?: { vectors?: unknown } };
}): number | undefined {
  const vectors = collection.config?.params?.vectors;
  if (!vectors || typeof vectors !== "object") return undefined;
  if ("size" in vectors && typeof vectors.size === "number") {
    return vectors.size;
  }
  if (
    "default" in vectors &&
    vectors.default &&
    typeof vectors.default === "object" &&
    "size" in vectors.default &&
    typeof vectors.default.size === "number"
  ) {
    return vectors.default.size;
  }
  return undefined;
}

/**
 * 嵌入模型切换后，若 collection 向量维度与当前模型不一致，则删除旧 collection。
 * 下次写入时 LangChain 会按新维度自动重建（避免 FakeEmbeddings 4 维 vs 真实模型 1024 维报错）。
 */
async function ensureCollectionDimension(
  config: Required<VectorStoreConfig>,
  embeddings: EmbeddingsInterface,
): Promise<void> {
  const client = new QdrantClient({
    url: config.url,
    apiKey: config.apiKey || undefined,
  });
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === config.collectionName)) return;

  const collection = await client.getCollection(config.collectionName);
  const existingDim = readCollectionVectorSize(collection);
  if (existingDim === undefined) return;

  const expectedDim = (await embeddings.embedQuery("dimension-probe")).length;
  if (existingDim === expectedDim) return;

  console.warn(
    `[Qdrant] collection "${config.collectionName}" 维度 ${existingDim} ≠ ${expectedDim}，已自动删除并将在写入时重建`,
  );
  await client.deleteCollection(config.collectionName);
}

/** Qdrant 向量库封装 */
export class VectorStore implements VectorStoreType {
  private constructor(private readonly store: LangchainQdrantVectorStore) {}

  /** 打开 LangChain Qdrant 客户端，并在连接前校验向量维度 */
  private static async openLangchainStore(
    overrides: Partial<VectorStoreConfig> = {},
  ): Promise<LangchainQdrantVectorStore> {
    const config = resolveConfig(overrides);
    const embeddings = createEmbeddings();
    await ensureCollectionDimension(config, embeddings);
    return LangchainQdrantVectorStore.fromExistingCollection(embeddings, {
      url: config.url,
      apiKey: config.apiKey || undefined,
      collectionName: config.collectionName,
    });
  }

  /** 连接 Qdrant collection（不存在时 LangChain 会在首次写入时自动创建） */
  static async open(
    overrides: Partial<VectorStoreConfig> = {},
  ): Promise<VectorStoreType> {
    const store = await VectorStore.openLangchainStore(overrides);
    return new VectorStore(store);
  }

  /**
   * 写入 Document 向量。
   * replace 默认为 true：同 documentId 先删后写，避免重复入库。
   */
  async addDocuments(docs: Document[], options: IngestOptions): Promise<number> {
    if (docs.length === 0) return 0;

    if (options.replace !== false) {
      await this.deleteByDocumentId(options.documentId, options.tenantId);
    }

    const enriched = enrichDocuments(docs, options);
    for (let i = 0; i < enriched.length; i += INGEST_BATCH_SIZE) {
      const batch = enriched.slice(i, i + INGEST_BATCH_SIZE);
      await this.store.addDocuments(batch);
    }
    return enriched.length;
  }

  /** 加载文件 → 切分 → 入库（source 默认为文件路径） */
  async ingestFile(filePath: string, options: IngestOptions): Promise<number> {
    const loader = new TextLoader(filePath);
    const docs = await loader.load();
    const chunks = await splitDocuments(filePath, docs, options);
    return this.addDocuments(chunks, { ...options, source: options.source ?? filePath });
  }

  /** 按 documentId + tenantId 删除该文档的全部 chunk 向量 */
  async deleteByDocumentId(
    documentId: string,
    tenantId: string,
  ): Promise<void> {
    await this.store.delete({
      filter: documentFilter(documentId, tenantId),
    });
  }

  /**
   * 向量相似度检索。
   * 仅返回指定 tenantId 下的结果；score 为相似度分数（越大越相关，具体范围取决于距离度量）。
   */
  async search(
    query: string,
    tenantId: string,
    topK: number = 10,
  ): Promise<RetrievedChunk[]> {
    const results = await this.store.similaritySearchWithScore(
      query,
      topK,
      tenantFilter(tenantId),
    );
    return results.map(([doc, score]) => toRetrievedChunk(doc, score));
  }
}

/** 从 .env 创建向量库实例（应用层推荐入口） */
export async function createVectorStore(
  overrides: Partial<VectorStoreConfig> = {},
): Promise<VectorStoreType> {
  return VectorStore.open(overrides);
}
