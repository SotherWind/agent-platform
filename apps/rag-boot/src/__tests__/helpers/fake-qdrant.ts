import { Document } from "@langchain/core/documents";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { VectorStore } from "../../vectorstore";
import { MemoryKnowledgePublicationStore, type KnowledgePublicationStore } from "../../knowledge-publication";
import type { KnowledgeChangeAuditSink, VectorStoreType } from "../../type";

type Filter = NonNullable<Parameters<QdrantClient["count"]>[1]>["filter"];

export function matchesFilter(doc: Document, filter: any): boolean {
  if (!filter) return true;
  if (filter.must?.some((condition: unknown) => !matchesFilter(doc, condition))) return false;
  if (filter.must_not?.some((condition: unknown) => matchesFilter(doc, condition))) return false;
  if (filter.should?.length && !filter.should.some((condition: unknown) => matchesFilter(doc, condition))) return false;
  const valueAt = (path: string): unknown => path.split(".").reduce<any>((value, key) => value?.[key], doc);
  if (filter.is_empty) {
    const value = valueAt(filter.is_empty.key);
    return value == null || (Array.isArray(value) && value.length === 0);
  }
  if (filter.key) {
    const value = valueAt(filter.key);
    const values = Array.isArray(value) ? value : [value];
    if (filter.match?.value !== undefined) return values.includes(filter.match.value);
    if (filter.match?.any) return values.some((v) => filter.match.any.includes(v));
    if (filter.match?.except) return value != null && values.some((v) => !filter.match.except.includes(v));
    if (filter.range) return typeof value === "number" &&
      (filter.range.gt === undefined || value > filter.range.gt) &&
      (filter.range.lte === undefined || value <= filter.range.lte);
  }
  return true;
}

export function fakeQdrant() {
  const rows: Document[] = [];
  const events: string[] = [];
  return {
    rows, events, collectionName: "test",
    failAddAt: 0, addCount: 0, failDelete: false,
    onAdd: undefined as (() => Promise<void>) | undefined,
    client: { count: async (_collection: string, options: { filter: Filter }) => ({
      count: rows.filter((doc) => matchesFilter(doc, options.filter)).length,
    }) },
    async addDocuments(docs: Document[]) {
      events.push("write");
      if (++this.addCount === this.failAddAt) throw new Error("embedding batch failed");
      rows.push(...docs);
      await this.onAdd?.();
      return docs.map((doc) => String(doc.metadata.id));
    },
    async delete(options: { filter: Filter }) {
      events.push("delete");
      if (this.failDelete) throw new Error("cleanup failed");
      for (let i = rows.length - 1; i >= 0; i--) if (matchesFilter(rows[i], options.filter)) rows.splice(i, 1);
    },
    async similaritySearchWithScore(_query: string, topK: number, filter: Filter): Promise<Array<[Document, number]>> {
      return rows.filter((doc) => matchesFilter(doc, filter)).slice(0, topK).map((doc) => [doc, 0.9]);
    },
  };
}

export function testVectorStore(
  fake = fakeQdrant(),
  sink?: KnowledgeChangeAuditSink,
  publications: KnowledgePublicationStore = new MemoryKnowledgePublicationStore(),
): VectorStoreType {
  const Constructor = VectorStore as unknown as new (
    store: unknown, sink?: KnowledgeChangeAuditSink, publications?: KnowledgePublicationStore,
  ) => VectorStoreType;
  return new Constructor(fake, sink, publications);
}
