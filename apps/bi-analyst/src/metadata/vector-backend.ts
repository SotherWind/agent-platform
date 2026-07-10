import type { SchemaDocType, ReviewStatus } from "./types.js";
import { payloadToDocument } from "./index-utils.js";
import type { SchemaDocument } from "./types.js";

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface VectorSearchFilter {
  docType?: SchemaDocType;
  datasourceId?: string;
  table?: string;
  tables?: string[];
  reviewStatus?: ReviewStatus;
  excludeDeleted?: boolean;
}

export interface VectorSearchHit {
  point: VectorPoint;
  score: number;
}

export interface VectorIndexBackend {
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(
    collection: string,
    queryVector: number[],
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<VectorSearchHit[]>;
  createCollection(name: string, vectorSize: number): Promise<void>;
  collectionExists(name: string): Promise<boolean>;
  setAlias(alias: string, collection: string): Promise<void>;
  getAliasTarget(alias: string): Promise<string | null>;
  deleteCollection(name: string): Promise<void>;
  getPoint(collection: string, id: string): Promise<VectorPoint | null>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function matchesFilter(
  payload: Record<string, unknown>,
  filter: VectorSearchFilter,
): boolean {
  if (filter.excludeDeleted !== false && payload.deleted === true) {
    return false;
  }
  if (filter.docType && payload.docType !== filter.docType) return false;
  if (filter.datasourceId && payload.datasourceId !== filter.datasourceId) {
    return false;
  }
  if (filter.table && payload.table !== filter.table) return false;
  if (filter.tables?.length) {
    const table = payload.table as string | undefined;
    if (!table || !filter.tables.includes(table)) return false;
  }
  if (filter.reviewStatus && payload.reviewStatus !== filter.reviewStatus) {
    return false;
  }
  return true;
}

/** 内存向量索引：unit/contract 测试用，行为与 Qdrant 后端对齐 */
export class InMemoryVectorIndexBackend implements VectorIndexBackend {
  private readonly collections = new Map<string, Map<string, VectorPoint>>();
  private readonly aliases = new Map<string, string>();

  resolveCollection(nameOrAlias: string): string {
    return this.aliases.get(nameOrAlias) ?? nameOrAlias;
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const resolved = this.resolveCollection(collection);
    if (!this.collections.has(resolved)) {
      await this.createCollection(resolved, points[0]?.vector.length ?? 64);
    }
    const store = this.collections.get(resolved)!;
    for (const point of points) {
      store.set(point.id, point);
    }
  }

  async search(
    collection: string,
    queryVector: number[],
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<VectorSearchHit[]> {
    const resolved = this.resolveCollection(collection);
    const store = this.collections.get(resolved);
    if (!store) return [];

    const hits: VectorSearchHit[] = [];
    for (const point of store.values()) {
      if (!matchesFilter(point.payload, filter)) continue;
      hits.push({
        point,
        score: cosineSimilarity(queryVector, point.vector),
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async createCollection(name: string, _vectorSize: number): Promise<void> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(this.resolveCollection(name));
  }

  async setAlias(alias: string, collection: string): Promise<void> {
    if (!this.collections.has(collection)) {
      throw new Error(`Collection ${collection} 不存在，无法设置 alias`);
    }
    this.aliases.set(alias, collection);
  }

  async getAliasTarget(alias: string): Promise<string | null> {
    return this.aliases.get(alias) ?? null;
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name);
    for (const [alias, target] of this.aliases.entries()) {
      if (target === name) this.aliases.delete(alias);
    }
  }

  async getPoint(collection: string, id: string): Promise<VectorPoint | null> {
    const resolved = this.resolveCollection(collection);
    return this.collections.get(resolved)?.get(id) ?? null;
  }
}

export function hitsToDocuments(hits: VectorSearchHit[]): SchemaDocument[] {
  return hits.map((hit) => payloadToDocument(hit.point.payload));
}
