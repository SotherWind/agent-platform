import assert from "node:assert/strict";
import { createTestPrincipal } from "../helpers/principal.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { createDemoRetriever } from "../../src/metadata/demo-documents.js";
import { InMemorySchemaRetriever } from "../../src/metadata/retriever.js";
import {
  createIndexedVectorRetriever,
  VectorSchemaRetriever,
} from "../../src/metadata/vector-schema-retriever.js";
import { InMemoryVectorIndexBackend } from "../../src/metadata/vector-backend.js";
import type { SchemaRetriever } from "../../src/metadata/retriever.js";
import type { SchemaDocument } from "../../src/metadata/types.js";
import { test, section } from "../helpers/runner.js";

const SAMPLE_DOCS: SchemaDocument[] = [
  {
    id: "ds:test",
    docType: "datasource",
    datasourceId: "test",
    domain: "retail",
    dialectFamily: "sqlite",
    reviewStatus: "approved",
    content: "测试数据源",
  },
  {
    id: "test.users",
    docType: "table",
    datasourceId: "test",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    reviewStatus: "approved",
    content: "用户表",
  },
  {
    id: "test.users.city",
    docType: "column",
    datasourceId: "test",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    column: "city",
    fieldRole: "dimension",
    reviewStatus: "approved",
    content: "城市字段",
  },
  {
    id: "test.secret",
    docType: "column",
    datasourceId: "test",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    column: "ssn",
    sensitivity: "pii",
    reviewStatus: "pending",
    content: "敏感字段",
  },
];

/** 所有 SchemaRetriever 实现必须通过的 contract 行为 */
export async function runSchemaRetrieverContract(
  label: string,
  factory: () => SchemaRetriever | Promise<SchemaRetriever>,
  options: { datasourceId: string; searchQuery: string },
) {
  section(`Contract: SchemaRetriever (${label})`);

  const principal = createTestPrincipal({ tenantId: "tenant-1" });
  const policy = createDefaultAccessPolicy(principal, [options.datasourceId]);

  await test("按 docType 过滤文档", async () => {
    const retriever = await factory();
    const tables = await retriever.search(
      options.searchQuery,
      { docType: "table", datasourceId: options.datasourceId, limit: 5 },
      policy,
    );
    assert.ok(tables.length >= 1);
    assert.ok(tables.every((d) => d.docType === "table"));
  });

  await test("未审核文档不可检索", async () => {
    const retriever = await factory();
    const columns = await retriever.search(
      "ssn",
      { docType: "column", datasourceId: options.datasourceId, limit: 10 },
      policy,
    );
    assert.ok(
      columns.every((d) => d.reviewStatus === "approved"),
      "pending 文档不应出现在结果中",
    );
  });

  await test("权限策略过滤未授权数据源", async () => {
    const retriever = await factory();
    const restrictedPolicy = createDefaultAccessPolicy(principal, ["other-ds"]);
    const docs = await retriever.search(
      options.searchQuery,
      { docType: "table", limit: 5 },
      restrictedPolicy,
    );
    assert.equal(docs.length, 0);
  });

  await test("无匹配时返回空数组", async () => {
    const retriever = await factory();
    const docs = await retriever.search(
      "xyznonexistent12345",
      { docType: "table", datasourceId: options.datasourceId, limit: 5 },
      policy,
    );
    assert.deepEqual(docs, []);
  });
  await test("in-memory snapshots expose indexedAt", async () => {
    const retriever = await factory();
    const docs = await retriever.search(
      options.searchQuery,
      { docType: "table", datasourceId: options.datasourceId, limit: 5 },
      policy,
    );
    assert.ok(docs.length > 0);
    assert.ok(docs.every((doc) => doc.indexedAt));
  });
}

export async function testSchemaRetrieverContract() {
  await runSchemaRetrieverContract(
    "InMemorySchemaRetriever",
    () => new InMemorySchemaRetriever(SAMPLE_DOCS),
    { datasourceId: "test", searchQuery: "用户" },
  );

  await runSchemaRetrieverContract(
    "DemoRetriever",
    () => createDemoRetriever(),
    { datasourceId: "ecommerce_sqlite", searchQuery: "订单" },
  );

  await runSchemaRetrieverContract(
    "VectorSchemaRetriever",
    async () => {
      const { retriever } = await createIndexedVectorRetriever(SAMPLE_DOCS, {
        collectionAlias: "contract-vector-test",
      });
      return retriever;
    },
    { datasourceId: "test", searchQuery: "用户" },
  );

  await test("VectorSchemaRetriever deduplicates query embeddings", async () => {
    let embedCalls = 0;
    const embeddings = {
      modelVersion: "test",
      vectorSize: 2,
      async embed(_texts: string[]) {
        embedCalls += 1;
        return [[1, 0]];
      },
    };
    const backend = new InMemoryVectorIndexBackend();
    await backend.createCollection("query-cache-test", 2);
    await backend.upsert("query-cache-test", [
      {
        id: "test.users",
        vector: [1, 0],
        payload: {
          id: "test.users",
          docType: "table",
          datasourceId: "test",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "users",
          reviewStatus: "approved",
          content: "users",
        },
      },
    ]);
    const retriever = new VectorSchemaRetriever({
      backend,
      embeddings,
      collectionAlias: "query-cache-test",
    });
    await Promise.all([
      retriever.search("same query", { docType: "table", datasourceId: "test" }),
      retriever.search("same query", { docType: "table", datasourceId: "test" }),
    ]);
    assert.equal(embedCalls, 1);
  });
}
