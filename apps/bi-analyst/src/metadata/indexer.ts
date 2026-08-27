import {
  DEFAULT_SCHEMA_VERSION,
  enrichDocumentForIndex,
  documentToPayload,
  markTombstone,
  payloadToDocument,
} from "./index-utils.js";
import { toStablePointId } from "./point-id.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorIndexBackend, VectorPoint } from "./vector-backend.js";
import type { SchemaDocument } from "./types.js";

export interface SchemaIndexerOptions {
  backend: VectorIndexBackend;
  embeddings: EmbeddingProvider;
  collectionAlias: string;
  schemaVersion?: string;
}

export interface IndexResult {
  collection: string;
  indexedCount: number;
  schemaVersion: string;
}

export interface AliasSwapResult {
  alias: string;
  newCollection: string;
  previousCollection: string | null;
  indexedCount: number;
}

export class SchemaIndexer {
  private readonly schemaVersion: string;
  private collectionSeq = 0;

  constructor(private readonly options: SchemaIndexerOptions) {
    this.schemaVersion =
      options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  }

  get collectionAlias(): string {
    return this.options.collectionAlias;
  }

  getSchemaVersion(): string {
    return this.schemaVersion;
  }

  async getAliasTarget(): Promise<string | null> {
    return this.options.backend.getAliasTarget(this.options.collectionAlias);
  }

  async readCurrentDocuments(): Promise<SchemaDocument[]> {
    const target = await this.getAliasTarget();
    if (!target) return [];
    const points = await this.options.backend.listPoints(target);
    return points
      .filter((point) => point.payload.deleted !== true)
      .map((point) => payloadToDocument(point.payload));
  }

  private collectionName(suffix?: string): string {
    this.collectionSeq += 1;
    const stamp = `${Date.now().toString(36)}-${this.collectionSeq}`;
    const label = suffix ? `${suffix}-${stamp}` : stamp;
    return `bi-metadata-${this.schemaVersion}-${label}`;
  }

  async indexDocuments(
    docs: SchemaDocument[],
    targetCollection?: string,
  ): Promise<IndexResult> {
    const collection = targetCollection ?? this.collectionName();
    const enriched = docs.map((doc) =>
      enrichDocumentForIndex(
        doc,
        this.schemaVersion,
        this.options.embeddings.modelVersion,
      ),
    );

    const vectors = await this.options.embeddings.embed(
      enriched.map((d) => d.content),
    );

    await this.options.backend.createCollection(
      collection,
      this.options.embeddings.vectorSize,
    );

    const points: VectorPoint[] = enriched.map((doc, i) => ({
      id: toStablePointId(doc.id),
      vector: vectors[i]!,
      payload: documentToPayload(doc),
    }));

    await this.options.backend.upsert(collection, points);

    return {
      collection,
      indexedCount: points.length,
      schemaVersion: this.schemaVersion,
    };
  }

  async tombstone(ids: string[], collection?: string): Promise<void> {
    const target =
      collection ??
      (await this.options.backend.getAliasTarget(
        this.options.collectionAlias,
      )) ??
      this.options.collectionAlias;

    for (const id of ids) {
      const pointId = toStablePointId(id);
      const existing = await this.options.backend.getPoint(target, pointId);
      if (!existing) continue;

      const doc = markTombstone(
        enrichDocumentForIndex(
          {
            id,
            docType: existing.payload.docType as SchemaDocument["docType"],
            content: String(existing.payload.content ?? ""),
            datasourceId: String(existing.payload.datasourceId),
            domain: String(existing.payload.domain),
            dialectFamily: existing.payload
              .dialectFamily as SchemaDocument["dialectFamily"],
            table: existing.payload.table as string | undefined,
            column: existing.payload.column as string | undefined,
            reviewStatus: existing.payload
              .reviewStatus as SchemaDocument["reviewStatus"],
          },
          this.schemaVersion,
          this.options.embeddings.modelVersion,
        ),
      );

      await this.options.backend.upsert(target, [
        {
          id: pointId,
          vector: existing.vector,
          payload: documentToPayload(doc),
        },
      ]);
    }
  }

  /** 全量重建 → 新 collection → alias 原子切换；失败时不改 alias */
  async rebuildWithAliasSwap(docs: SchemaDocument[]): Promise<AliasSwapResult> {
    const alias = this.options.collectionAlias;
    const previousCollection =
      await this.options.backend.getAliasTarget(alias);
    const newCollection = this.collectionName("rebuild");

    const indexResult = await this.indexDocuments(docs, newCollection);
    await this.options.backend.setAlias(alias, newCollection);

    return {
      alias,
      newCollection,
      previousCollection,
      indexedCount: indexResult.indexedCount,
    };
  }

  /** 将 alias 切回上一 collection（灰度/坏索引回滚） */
  async rollbackAlias(previousCollection: string): Promise<void> {
    if (!previousCollection.trim()) {
      throw new Error("无可回滚的 collection");
    }
    await this.options.backend.setAlias(
      this.options.collectionAlias,
      previousCollection,
    );
  }
}
