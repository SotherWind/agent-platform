import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import { MemoryKnowledgePublicationStore } from "../knowledge-publication";
import type { KnowledgeChangeAuditEntry } from "../type";
import { fakeQdrant, testVectorStore } from "./helpers/fake-qdrant";

const doc = (content: string) => new Document({ pageContent: content, metadata: {} });
const options = { tenantId: "t", documentId: "policy" };

describe("T8.3 staged knowledge publication", () => {
  it("writes a complete new generation before cleanup, and append retains both versions", async () => {
    const fake = fakeQdrant();
    const store = testVectorStore(fake);
    await store.addDocuments([doc("v1")], options);
    expect(fake.events).toEqual(["write", "delete"]);
    await store.addDocuments([doc("v2")], options);
    expect((await store.search("q", "t", 10)).map((chunk) => chunk.content)).toEqual(["v2"]);
    expect(fake.rows.map((row) => row.pageContent)).toEqual(["v2"]);
    await store.addDocuments([doc("extra")], { ...options, replace: false });
    expect((await store.search("q", "t", 10)).map((chunk) => chunk.content)).toEqual(["v2", "extra"]);
  });

  it("records create, replace and delete with version and chunk count", async () => {
    const audit: KnowledgeChangeAuditEntry[] = [];
    const store = testVectorStore(undefined, (entry) => { audit.push(entry); });
    await store.addDocuments([doc("a"), doc("b")], { ...options, version: 2 });
    await store.addDocuments([doc("c")], { ...options, version: 3 });
    await store.deleteByDocumentId("policy", "t");
    expect(audit.map((entry) => entry.action)).toEqual(["create", "replace", "delete"]);
    expect(audit[0]).toMatchObject({ chunkCount: 2, tenantId: "t", version: 2 });
    expect(audit[1]).toMatchObject({ chunkCount: 1, version: 3 });
    expect(await store.search("q", "t", 10)).toEqual([]);
  });

  it("partial embedding failure preserves the old version and hides staging", async () => {
    const fake = fakeQdrant();
    const store = testVectorStore(fake);
    await store.addDocuments([doc("old")], options);
    fake.failAddAt = 3;
    fake.onAdd = async () => {
      expect((await store.search("q", "t", 100)).map((chunk) => chunk.content)).toEqual(["old"]);
    };
    await expect(store.addDocuments(Array.from({ length: 33 }, () => doc("new")), options)).rejects.toThrow("batch failed");
    expect((await store.search("q", "t", 100)).map((chunk) => chunk.content)).toEqual(["old"]);
    expect(fake.rows).toHaveLength(1);
  });

  it("concurrent publication cannot delete the winning generation", async () => {
    const fake = fakeQdrant();
    const publications = new MemoryKnowledgePublicationStore();
    const first = testVectorStore(fake, undefined, publications);
    const second = testVectorStore(fake, undefined, publications);
    await first.addDocuments([doc("old")], options);
    fake.onAdd = async () => {
      fake.onAdd = undefined;
      await second.addDocuments([doc("winner")], options);
    };
    await expect(first.addDocuments([doc("loser")], options)).rejects.toThrow("Concurrent");
    expect((await first.search("q", "t", 10)).map((chunk) => chunk.content)).toEqual(["winner"]);
  });

  it("cleanup failure does not roll back publication or expose stale knowledge", async () => {
    const fake = fakeQdrant();
    const store = testVectorStore(fake);
    await store.addDocuments([doc("old")], options);
    fake.failDelete = true;
    await store.addDocuments([doc("new")], options);
    expect(fake.rows).toHaveLength(2);
    expect((await store.search("q", "t", 10)).map((chunk) => chunk.content)).toEqual(["new"]);
    await expect(store.deleteByDocumentId("policy", "t")).rejects.toThrow("cleanup");
    expect(await store.search("q", "t", 10)).toEqual([]);
    fake.failDelete = false;
    await store.addDocuments([doc("restored")], options);
    expect((await store.search("q", "t", 10)).map((chunk) => chunk.content)).toEqual(["restored"]);
  });

  it("first publication hides legacy vectors only after the new version is complete", async () => {
    const fake = fakeQdrant();
    fake.rows.push(new Document({
      pageContent: "legacy", metadata: { tenantId: "t", documentId: "policy", id: "legacy" },
    }));
    const store = testVectorStore(fake);
    fake.onAdd = async () => {
      expect((await store.search("q", "t", 10)).map((chunk) => chunk.content)).toEqual(["legacy"]);
    };
    await store.addDocuments([doc("new")], options);
    expect(fake.rows.map((row) => row.pageContent)).toEqual(["new"]);
  });
});
