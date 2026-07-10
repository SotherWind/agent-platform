import assert from "node:assert/strict";
import { createTestPrincipal } from "../../../src/auth/principal.js";
import { createDefaultAccessPolicy } from "../../../src/policy/access-policy.js";
import { createDemoRetriever } from "../../../src/metadata/demo-documents.js";
import { evaluateGoldenQuery } from "../../../src/metadata/evaluation.js";
import { loadGoldenQueries } from "../../helpers/golden-queries.js";
import { test, section, addSkipped } from "../../helpers/runner.js";

async function isQdrantReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url.replace(/\/$/, "")}/healthz`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function testQdrantMetadataIntegration(enabled: boolean) {
  section("Integration Services: Qdrant 元数据索引");

  if (!enabled) {
    console.log("  ⊘ 跳过：设置 RUN_INTEGRATION_SERVICES=1");
    addSkipped(3);
    return;
  }

  const qdrantUrl = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
  if (!(await isQdrantReachable(qdrantUrl))) {
    console.log(`  ⊘ 跳过：Qdrant 不可达 (${qdrantUrl})`);
    addSkipped(3);
    return;
  }

  const { createMetadataStack } = await import(
    "../../../src/metadata/metadata-factory.js"
  );
  const { DEMO_SCHEMA_DOCUMENTS } = await import(
    "../../../src/metadata/demo-documents.js"
  );
  const alias = `bi-metadata-it-${Date.now()}`;

  await test("rebuildWithAliasSwap 写入 Qdrant", async () => {
    const { indexer } = createMetadataStack({
      qdrantUrl,
      collectionAlias: alias,
    });
    const result = await indexer.rebuildWithAliasSwap(DEMO_SCHEMA_DOCUMENTS);
    assert.equal(result.indexedCount, DEMO_SCHEMA_DOCUMENTS.length);
    assert.ok(result.newCollection);
  });

  await test("VectorSchemaRetriever 从 Qdrant 检索表", async () => {
    const { retriever } = createMetadataStack({
      qdrantUrl,
      collectionAlias: alias,
    });
    const principal = createTestPrincipal({ tenantId: "tenant-1" });
    const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);
    const tables = await retriever.search(
      "订单",
      { docType: "table", datasourceId: "ecommerce_sqlite", limit: 5 },
      policy,
    );
    assert.ok(tables.some((t) => t.table === "orders"));
  });

  await test("tombstone 后文档不可检索", async () => {
    const { indexer, retriever } = createMetadataStack({
      qdrantUrl,
      collectionAlias: alias,
    });
    await indexer.tombstone(["ecommerce_sqlite.orders"]);
    const principal = createTestPrincipal({ tenantId: "tenant-1" });
    const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);
    const tables = await retriever.search(
      "订单",
      { docType: "table", datasourceId: "ecommerce_sqlite", limit: 5 },
      policy,
    );
    assert.ok(!tables.some((t) => t.id === "ecommerce_sqlite.orders"));
  });
}

export async function testGoldenQueries() {
  section("Golden Queries (Schema RAG 召回)");

  for (const gq of loadGoldenQueries()) {
    await test(`${gq.id} ${gq.description ?? gq.query}`, async () => {
      const retriever = createDemoRetriever();
      const principal = createTestPrincipal({ tenantId: "tenant-1" });
      const policy = createDefaultAccessPolicy(principal, [
        gq.expected.datasourceId,
      ]);

      const result = await evaluateGoldenQuery(retriever, gq, policy);
      assert.ok(
        result.passed,
        `召回失败：missingTables=${result.missingTables.join(",")} missingColumns=${result.missingColumns.join(",")}`,
      );
    });
  }
}
