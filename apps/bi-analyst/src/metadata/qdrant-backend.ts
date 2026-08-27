import { QdrantClient } from "@qdrant/js-client-rest";
import type { SchemaDocType, ReviewStatus } from "./types.js";
import { payloadToDocument } from "./index-utils.js";
import type { SchemaDocument } from "./types.js";
import type {
  VectorIndexBackend,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchHit,
} from "./vector-backend.js";

export interface QdrantBackendOptions {
  url: string;
  apiKey?: string;
}

function buildQdrantFilter(filter: VectorSearchFilter): Record<string, unknown> {
  const must: Record<string, unknown>[] = [];

  if (filter.excludeDeleted !== false) {
    must.push({
      key: "deleted",
      match: { value: false },
    });
  }
  if (filter.docType) {
    must.push({ key: "docType", match: { value: filter.docType } });
  }
  if (filter.datasourceId) {
    must.push({
      key: "datasourceId",
      match: { value: filter.datasourceId },
    });
  }
  if (filter.table) {
    must.push({ key: "table", match: { value: filter.table } });
  }
  if (filter.tables?.length) {
    must.push({ key: "table", match: { any: filter.tables } });
  }
  if (filter.reviewStatus) {
    must.push({
      key: "reviewStatus",
      match: { value: filter.reviewStatus },
    });
  }

  return must.length > 0 ? { must } : {};
}

/** 生产/集成测试用 Qdrant 向量后端 */
export class QdrantVectorIndexBackend implements VectorIndexBackend {
  private readonly client: QdrantClient;

  constructor(options: QdrantBackendOptions) {
    this.client = new QdrantClient({
      url: options.url,
      apiKey: options.apiKey,
    });
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(
    collection: string,
    queryVector: number[],
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<VectorSearchHit[]> {
    const resolved = await this.resolveCollection(collection);
    // Qdrant JS 1.19 removed the legacy `search` method in favor of the
    // universal `query` endpoint. Keep a small compatibility fallback for
    // older deployed clients while compiling against the current API.
    const client = this.client as QdrantClient & {
      search?: (collection: string, input: Record<string, unknown>) => Promise<unknown>;
    };
    const result =
      typeof this.client.query === "function"
        ? await this.client.query(resolved, {
            query: queryVector,
            limit,
            filter: buildQdrantFilter(filter),
            with_payload: true,
          })
        : await client.search!(resolved, {
            vector: queryVector,
            limit,
            filter: buildQdrantFilter(filter),
            with_payload: true,
          });
    const points = Array.isArray(result)
      ? result
      : ((result as { points?: unknown[] }).points ?? []);

    return points.map((item: unknown) => {
      const scored = item as {
        score?: number;
        id: string | number;
        payload?: Record<string, unknown> | null;
      };
      return {
      score: scored.score ?? 0,
      point: {
        id: String(scored.id),
        vector: queryVector,
        payload: (scored.payload ?? {}) as Record<string, unknown>,
      },
      };
    });
  }

  async createCollection(name: string, vectorSize: number): Promise<void> {
    const exists = await this.collectionExists(name);
    if (exists) return;

    await this.client.createCollection(name, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });
  }

  async collectionExists(name: string): Promise<boolean> {
    try {
      await this.client.getCollection(name);
      return true;
    } catch {
      return false;
    }
  }

  async setAlias(alias: string, collection: string): Promise<void> {
    type AliasAction =
      | { create_alias: { collection_name: string; alias_name: string } }
      | { delete_alias: { alias_name: string } };

    const actions: AliasAction[] = [];

    try {
      const existing = await this.client.getAliases();
      const current = existing.aliases.find((a) => a.alias_name === alias);
      if (current?.collection_name) {
        actions.push({ delete_alias: { alias_name: alias } });
      }
    } catch {
      // alias 不存在时直接创建
    }

    actions.push({
      create_alias: { collection_name: collection, alias_name: alias },
    });

    await this.client.updateCollectionAliases({ actions });
  }

  async getAliasTarget(alias: string): Promise<string | null> {
    try {
      const existing = await this.client.getAliases();
      const match = existing.aliases.find((a) => a.alias_name === alias);
      return match?.collection_name ?? null;
    } catch {
      return null;
    }
  }

  async deleteCollection(name: string): Promise<void> {
    await this.client.deleteCollection(name);
  }

  async getPoint(collection: string, id: string): Promise<VectorPoint | null> {
    const resolved = await this.resolveCollection(collection);
    const result = await this.client.retrieve(resolved, {
      ids: [id],
      with_payload: true,
      with_vector: true,
    });
    const point = result[0];
    if (!point) return null;

    return {
      id: String(point.id),
      vector: (point.vector as number[]) ?? [],
      payload: (point.payload ?? {}) as Record<string, unknown>,
    };
  }

  async listPoints(collection: string): Promise<VectorPoint[]> {
    const resolved = await this.resolveCollection(collection);
    const points: VectorPoint[] = [];
    let offset: string | number | undefined;
    do {
      const page = await this.client.scroll(resolved, {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: true,
      });
      for (const point of page.points) {
        points.push({
          id: String(point.id),
          vector: (point.vector as number[]) ?? [],
          payload: (point.payload ?? {}) as Record<string, unknown>,
        });
      }
      offset = page.next_page_offset as string | number | undefined;
    } while (offset !== undefined && offset !== null);
    return points;
  }

  private async resolveCollection(nameOrAlias: string): Promise<string> {
    const aliasTarget = await this.getAliasTarget(nameOrAlias);
    return aliasTarget ?? nameOrAlias;
  }
}

export type { SchemaDocument, SchemaDocType, ReviewStatus };
