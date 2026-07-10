import assert from "node:assert/strict";
import { toStablePointId } from "../../src/metadata/point-id.js";
import {
  computeContentHash,
  enrichDocumentForIndex,
} from "../../src/metadata/index-utils.js";
import { DeterministicEmbeddingProvider } from "../../src/metadata/embeddings.js";
import { InMemoryVectorIndexBackend } from "../../src/metadata/vector-backend.js";
import { SchemaIndexer } from "../../src/metadata/indexer.js";
import { VectorSchemaRetriever } from "../../src/metadata/vector-schema-retriever.js";
import { DEMO_SCHEMA_DOCUMENTS } from "../../src/metadata/demo-documents.js";
import { createTestPrincipal } from "../../src/auth/principal.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { test, section } from "../helpers/runner.js";

const SAMPLE_DOC = {
  id: "test.users.city",
  docType: "column" as const,
  datasourceId: "test",
  domain: "retail",
  dialectFamily: "sqlite" as const,
  table: "users",
  column: "city",
  reviewStatus: "approved" as const,
  content: "城市维度字段 city",
};

export async function testMetadataIndexer() {
  section("Schema Indexer (Phase B)");

  await test("computeContentHash 对相同内容稳定", () => {
    const a = computeContentHash("hello");
    const b = computeContentHash("hello");
    assert.notEqual(a, computeContentHash("world"));
    assert.equal(a, b);
  });

  await test("enrichDocumentForIndex 写入 schemaVersion/contentHash", () => {
    const enriched = enrichDocumentForIndex(SAMPLE_DOC, "2");
    assert.equal(enriched.schemaVersion, "2");
    assert.ok(enriched.contentHash);
    assert.ok(enriched.indexedAt);
    assert.equal(enriched.embeddingModelVersion, "deterministic-v1");
  });

  await test("indexDocuments 写入向量索引", async () => {
    const backend = new InMemoryVectorIndexBackend();
    const embeddings = new DeterministicEmbeddingProvider();
    const indexer = new SchemaIndexer({
      backend,
      embeddings,
      collectionAlias: "bi-test",
      schemaVersion: "1",
    });

    const result = await indexer.indexDocuments([SAMPLE_DOC], "col-a");
    assert.equal(result.indexedCount, 1);

    const point = await backend.getPoint("col-a", toStablePointId(SAMPLE_DOC.id));
    assert.ok(point);
    assert.equal(point.payload.contentHash, computeContentHash(SAMPLE_DOC.content));
  });

  await test("tombstone 后文档不可检索", async () => {
    const backend = new InMemoryVectorIndexBackend();
    const embeddings = new DeterministicEmbeddingProvider();
    const alias = "bi-tombstone-test";
    const indexer = new SchemaIndexer({
      backend,
      embeddings,
      collectionAlias: alias,
    });

    await indexer.rebuildWithAliasSwap([SAMPLE_DOC]);
    await indexer.tombstone([SAMPLE_DOC.id]);

    const retriever = new VectorSchemaRetriever({
      backend,
      embeddings,
      collectionAlias: alias,
    });
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, ["test"]);
    const docs = await retriever.search("城市", {
      docType: "column",
      datasourceId: "test",
      limit: 5,
    }, policy);

    assert.equal(docs.length, 0);
  });

  await test("rebuildWithAliasSwap 切换 alias 指向新 collection", async () => {
    const backend = new InMemoryVectorIndexBackend();
    const embeddings = new DeterministicEmbeddingProvider();
    const alias = "bi-alias-test";
    const indexer = new SchemaIndexer({
      backend,
      embeddings,
      collectionAlias: alias,
    });

    const first = await indexer.rebuildWithAliasSwap([SAMPLE_DOC]);
    assert.equal(await backend.getAliasTarget(alias), first.newCollection);

    const updatedDoc = {
      ...SAMPLE_DOC,
      content: "更新后的城市字段描述",
    };
    const second = await indexer.rebuildWithAliasSwap([updatedDoc]);
    assert.notEqual(second.newCollection, first.newCollection);
    assert.equal(second.previousCollection, first.newCollection);
    assert.equal(await backend.getAliasTarget(alias), second.newCollection);

    const retriever = new VectorSchemaRetriever({
      backend,
      embeddings,
      collectionAlias: alias,
    });
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, ["test"]);
    const docs = await retriever.search("更新后的城市", {
      docType: "column",
      datasourceId: "test",
      limit: 1,
    }, policy);
    assert.equal(docs[0]?.content, updatedDoc.content);
  });

  await test("VectorSchemaRetriever 索引 demo 文档后可检索", async () => {
    const backend = new InMemoryVectorIndexBackend();
    const embeddings = new DeterministicEmbeddingProvider();
    const alias = "bi-demo-vector";
    const indexer = new SchemaIndexer({
      backend,
      embeddings,
      collectionAlias: alias,
    });
    await indexer.rebuildWithAliasSwap(DEMO_SCHEMA_DOCUMENTS);

    const retriever = new VectorSchemaRetriever({
      backend,
      embeddings,
      collectionAlias: alias,
    });
    const principal = createTestPrincipal({ tenantId: "tenant-1" });
    const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);

    const tables = await retriever.search("北京用户订单", {
      docType: "table",
      datasourceId: "ecommerce_sqlite",
      limit: 5,
    }, policy);

    assert.ok(tables.some((t) => t.table === "orders" || t.table === "users"));
  });
}
