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
import { randomUUID } from "node:crypto";
import type {
  RetrievedChunk,
  VectorStoreConfig,
  IngestOptions,
  VectorStoreType,
  KnowledgeChangeAuditEntry,
  RetrievalScope,
} from "./type";
import { createEmbeddings } from "./embeddings";
import { MemoryKnowledgePublicationStore, type KnowledgePublicationStore, type KnowledgePublication } from "./knowledge-publication";
import { KNOWLEDGE_SCOPE_KEYS, matchesKnowledgeScope } from "./knowledge-scope";
import { TenantMissingError } from "./errors";

type QdrantFilter = NonNullable<Parameters<QdrantClient["count"]>[1]>["filter"];

/** 默认 chunk 字符数（与 RecursiveCharacterTextSplitter 一致） */
const DEFAULT_CHUNK_SIZE = 500;
/** 相邻 chunk 重叠字符数，避免语义在切分边界断裂 */
const DEFAULT_CHUNK_OVERLAP = 50;

/** 合并 overrides 与 .env，得到 Qdrant 连接配置 */
function resolveConfig(
  overrides: Partial<VectorStoreConfig> = {},
): Required<Pick<VectorStoreConfig, "url" | "apiKey" | "collectionName">> &
  Pick<VectorStoreConfig, "onKnowledgeChange"> {
  return {
    url: overrides.url ?? process.env.QDRANT_URL ?? "http://localhost:6333",
    apiKey: overrides.apiKey ?? process.env.QDRANT_API_KEY ?? "",
    collectionName:
      overrides.collectionName ??
      process.env.QDRANT_COLLECTION_NAME ??
      "rag_boot",
    onKnowledgeChange: overrides.onKnowledgeChange,
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
          version: options.version ?? 1,
          effectiveAt: options.effectiveAt ?? null,
          expiredAt: options.expiredAt ?? null,
          ...Object.fromEntries(KNOWLEDGE_SCOPE_KEYS
            .filter((key) => options.knowledgeScope?.[key] !== undefined)
            .map((key) => [key, [...options.knowledgeScope![key]!]])),
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
export function isKnowledgeDocumentActive(
  metadata: Record<string, unknown>,
  now: number = Date.now(),
): boolean {
  const effectiveAt = metadata.effectiveAt;
  const expiredAt = metadata.expiredAt;
  return (
    metadata.published !== false &&
    (typeof effectiveAt !== "number" || effectiveAt <= now) &&
    (typeof expiredAt !== "number" || expiredAt > now)
  );
}

export function knowledgeFilter(tenantId: string, now: number = Date.now(), scope: RetrievalScope = {}) {
  if (!tenantId.trim()) throw new TenantMissingError();
  return {
    must: [
      { key: "metadata.tenantId", match: { value: tenantId } },
      ...KNOWLEDGE_SCOPE_KEYS.map((key) => {
        const granted = [...(scope[key] ?? [])];
        const field = `metadata.${key}`;
        return {
          should: [
            { is_empty: { key: field } },
            ...(granted.length === 0 ? [] : key === "permissions"
              ? [{ must_not: [{ key: field, match: { except: granted } }] }]
              : [{ key: field, match: { any: granted } }]),
          ],
        };
      }),
    ],
    must_not: [
      { key: "metadata.published", match: { value: false } },
      { key: "metadata.effectiveAt", range: { gt: now } },
      { key: "metadata.expiredAt", range: { lte: now } },
    ],
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
 * A dimension mismatch requires an explicit migration, never deletion of live knowledge.
 */
async function ensureCollectionDimension(
  config: Pick<Required<VectorStoreConfig>, "url" | "apiKey" | "collectionName">,
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

  throw new Error(
    `Qdrant collection "${config.collectionName}" dimension ${existingDim} does not match ${expectedDim}; migrate to a new collection explicitly.`,
  );
}

/** Qdrant 向量库封装 */
export class VectorStore implements VectorStoreType {
  private constructor(
    private readonly store: LangchainQdrantVectorStore,
    private readonly onKnowledgeChange?: (entry: KnowledgeChangeAuditEntry) => void | Promise<void>,
    private readonly publications: KnowledgePublicationStore = new MemoryKnowledgePublicationStore(),
  ) {}

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

  /** 连接 Qdrant collection（不存在时 LangChain 会在连接期间创建） */
  static async open(
    overrides: Partial<VectorStoreConfig> = {},
  ): Promise<VectorStoreType> {
    if (!overrides.publications) {
      throw new Error("Qdrant requires an explicit publication store shared by all readers and writers.");
    }
    if (process.env.NODE_ENV === "production" && !overrides.publications?.durable) {
      throw new Error("Production vector store requires a durable knowledge publication store.");
    }
    const store = await VectorStore.openLangchainStore(overrides);
    return new VectorStore(store, overrides.onKnowledgeChange, overrides.publications);
  }

  /**
   * 写入 Document 向量。
   * Stage immutable generations, then atomically publish a complete generation.
   */
  async addDocuments(docs: Document[], options: IngestOptions): Promise<number> {
    if (!options.tenantId.trim()) throw new TenantMissingError();
    if (!options.documentId.trim()) throw new Error("documentId is required.");
    if (docs.length === 0) return 0;

    const previous = this.publications.get(options.tenantId, options.documentId);
    const replacedExisting = previous
      ? previous.generations.length > 0 || previous.legacy
      : await this.documentExists(options.documentId, options.tenantId);
    const generation = randomUUID();
    const enriched = enrichDocuments(docs, options).map((doc) => new Document({
      pageContent: doc.pageContent,
      metadata: { ...doc.metadata, publicationId: generation, id: `${generation}:${doc.metadata.id}` },
    }));
    try {
      for (let i = 0; i < enriched.length; i += INGEST_BATCH_SIZE) {
        await this.store.addDocuments(enriched.slice(i, i + INGEST_BATCH_SIZE));
      }
      this.publications.publish({
        tenantId: options.tenantId,
        documentId: options.documentId,
        generations: [...(options.replace === false ? previous?.generations ?? [] : []), generation],
        legacy: options.replace === false && (previous?.legacy ?? true),
      }, previous?.revision);
    } catch (error) {
      await this.store.delete({
        filter: { must: [
          ...documentFilter(options.documentId, options.tenantId).must,
          { key: "metadata.publicationId", match: { value: generation } },
        ] },
      }).catch(() => {});
      throw error;
    }
    if (options.replace !== false) {
      // Only remove generations observed before staging, never a concurrent publisher's data.
      await this.deletePublishedVectors(options.documentId, options.tenantId, previous).catch(() => {
        // Publication is committed; stale vectors remain invisible and can be cleaned later.
      });
    }
    await this.onKnowledgeChange?.({
      action: options.replace === false || !replacedExisting ? "create" : "replace",
      tenantId: options.tenantId,
      documentId: options.documentId,
      version: options.version ?? 1,
      effectiveAt: options.effectiveAt,
      expiredAt: options.expiredAt,
      chunkCount: enriched.length,
      at: Date.now(),
    });
    return enriched.length;
  }

  /** 加载文件 → 切分 → 入库（source 默认为文件路径） */
  async ingestFile(filePath: string, options: IngestOptions): Promise<number> {
    const loader = new TextLoader(filePath);
    const docs = await loader.load();
    const chunks = await splitDocuments(filePath, docs, options);
    return this.addDocuments(chunks, { ...options, source: options.source ?? filePath });
  }

  /**
   * 判断 documentId 下是否已有向量（供审计区分 create/replace）。
   * 生产路径用 Qdrant count；拿不到 client 的 store（测试里的轻量 fake）保守按
   * "存在"处理——保持 replace 语义，不强迫每个 fake 实现查询能力。
   */
  private async documentExists(documentId: string, tenantId: string): Promise<boolean> {
    const client = this.store.client;
    const collectionName = this.store.collectionName;
    if (!client || !collectionName) return true;
    const { count } = await client.count(collectionName, {
      filter: documentFilter(documentId, tenantId),
    });
    return count > 0;
  }

  private generationFilter(publications: KnowledgePublication[]): QdrantFilter {
    const noLegacy = publications.filter((publication) => !publication.legacy).map((publication) => publication.documentId);
    const generations = publications.flatMap((publication) => publication.generations);
    return {
      should: [
        { must: [{ is_empty: { key: "metadata.publicationId" } }],
          ...(noLegacy.length ? { must_not: [{ key: "metadata.documentId", match: { any: noLegacy } }] } : {}) },
        ...(generations.length ? [{ key: "metadata.publicationId", match: { any: generations } }] : []),
      ],
    };
  }

  private async deletePublishedVectors(documentId: string, tenantId: string, previous?: KnowledgePublication) {
    if (previous && !previous.legacy && previous.generations.length === 0) return;
    await this.store.delete({
      filter: {
        must: documentFilter(documentId, tenantId).must,
        should: [
          ...(previous?.legacy === false ? [] : [{ is_empty: { key: "metadata.publicationId" } }]),
          ...(previous?.generations.length ? [{ key: "metadata.publicationId", match: { any: previous.generations } }] : []),
        ],
      },
    });
  }

  /** 按 documentId + tenantId 删除该文档的全部 chunk 向量 */
  async deleteByDocumentId(
    documentId: string,
    tenantId: string,
  ): Promise<void> {
    if (!tenantId.trim()) throw new TenantMissingError();
    const previous = this.publications.get(tenantId, documentId);
    this.publications.publish({ tenantId, documentId, generations: [], legacy: false }, previous?.revision);
    await this.deletePublishedVectors(documentId, tenantId, previous);
    await this.onKnowledgeChange?.({
      action: "delete",
      tenantId,
      documentId,
      at: Date.now(),
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
    scope: RetrievalScope = {},
  ): Promise<RetrievedChunk[]> {
    const now = Date.now();
    const results = await this.store.similaritySearchWithScore(
      query,
      topK,
      { must: [knowledgeFilter(tenantId, now, scope), this.generationFilter(this.publications.list(tenantId))!] },
    );
    // 兼容旧 Qdrant / fake store 对 must_not 的忽略，应用层再做一次硬过滤。
    return results
      .filter(([doc]) => {
        const publication = this.publications.get(tenantId, String(doc.metadata.documentId));
        const generation = doc.metadata.publicationId;
        const published = generation === undefined
          ? publication?.legacy !== false
          : typeof generation === "string" && publication?.generations.includes(generation);
        return published && doc.metadata.tenantId === tenantId &&
          isKnowledgeDocumentActive(doc.metadata, now) && matchesKnowledgeScope(doc.metadata, scope);
      })
      .map(([doc, score]) => toRetrievedChunk(doc, score));
  }
}

/** 从 .env 创建向量库实例（应用层推荐入口） */
export async function createVectorStore(
  overrides: Partial<VectorStoreConfig> = {},
): Promise<VectorStoreType> {
  return VectorStore.open(overrides);
}
