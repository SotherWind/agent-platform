import type { RedisCacheBackend } from "../cache/redis-query-cache.js";
import {
  readRedisJson,
  redisKeySegment,
  withRedisLock,
  writeRedisJson,
} from "../state/redis-state.js";
import type { ReviewStatus, SchemaDocument } from "./types.js";
import type {
  MetadataReviewStore,
  ReviewDecision,
} from "./review.js";

export class RedisMetadataReviewStore implements MetadataReviewStore {
  constructor(
    private readonly backend: RedisCacheBackend,
    private readonly keyPrefix = "bi:state:v1:metadata-review:doc:",
  ) {}

  upsertDraft(): SchemaDocument {
    throw new Error("RedisMetadataReviewStore requires upsertDraftAsync()");
  }

  list(): SchemaDocument[] {
    throw new Error("RedisMetadataReviewStore requires listAsync()");
  }

  get(): SchemaDocument | undefined {
    throw new Error("RedisMetadataReviewStore requires getAsync()");
  }

  decide(): SchemaDocument {
    throw new Error("RedisMetadataReviewStore requires decideAsync()");
  }

  async upsertDraftAsync(doc: SchemaDocument): Promise<SchemaDocument> {
    if (doc.tags?.includes("certified")) {
      throw new Error("Metadata review cannot assign the certified tag");
    }
    const saved: SchemaDocument = {
      ...doc,
      reviewStatus: doc.reviewStatus ?? "draft",
    };
    await withRedisLock(this.backend, this.lockKey(doc.id), async () => {
      await writeRedisJson(this.backend, this.key(doc.id), saved);
    });
    return { ...saved };
  }

  async listAsync(filter?: {
    status?: ReviewStatus;
    datasourceId?: string;
    limit?: number;
  }): Promise<SchemaDocument[]> {
    const limit = Math.min(Math.max(1, filter?.limit ?? 50), 200);
    const keys = await this.backend.scan(`${this.keyPrefix}*`);
    const documents = await Promise.all(
      keys.map((key) => readRedisJson<SchemaDocument>(this.backend, key)),
    );
    return documents
      .filter((doc): doc is SchemaDocument => Boolean(doc))
      .filter((doc) => !filter?.status || doc.reviewStatus === filter.status)
      .filter(
        (doc) =>
          !filter?.datasourceId || doc.datasourceId === filter.datasourceId,
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((doc) => ({ ...doc }));
  }

  async getAsync(documentId: string): Promise<SchemaDocument | undefined> {
    const document = await readRedisJson<SchemaDocument>(
      this.backend,
      this.key(documentId),
    );
    return document ? { ...document } : undefined;
  }

  async decideAsync(
    documentId: string,
    decision: Omit<ReviewDecision, "documentId" | "reviewedAt"> & {
      note?: string;
    },
  ): Promise<SchemaDocument> {
    return withRedisLock(this.backend, this.lockKey(documentId), async () => {
      const document = await this.getAsync(documentId);
      if (!document) throw new Error(`Metadata document not found: ${documentId}`);
      if (document.tags?.includes("certified")) {
        throw new Error("Metadata review cannot assign the certified tag");
      }
      const updated: SchemaDocument = {
        ...document,
        reviewStatus: decision.status,
      };
      await writeRedisJson(this.backend, this.key(documentId), updated);
      return { ...updated };
    });
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.backend.ping?.();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  private key(documentId: string): string {
    return `${this.keyPrefix}${redisKeySegment(documentId)}`;
  }

  private lockKey(documentId: string): string {
    return `bi:state:v1:lock:metadata-review:${redisKeySegment(documentId)}`;
  }
}
