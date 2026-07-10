import assert from "node:assert/strict";
import { createTestPrincipal } from "../../src/auth/principal.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { createDemoRetriever } from "../../src/metadata/demo-documents.js";
import { DEMO_SCHEMA_DOCUMENTS } from "../../src/metadata/demo-documents.js";
import { evaluateGoldenQuerySet } from "../../src/metadata/evaluation.js";
import { createMetadataStack } from "../../src/metadata/metadata-factory.js";
import { DeterministicEmbeddingProvider } from "../../src/metadata/embeddings.js";
import { loadGoldenQueries } from "../helpers/golden-queries.js";
import { test, section } from "../helpers/runner.js";

export async function testSchemaRagEvaluation() {
  section("Schema RAG Evaluation");

  const goldenQueries = loadGoldenQueries();
  const principal = createTestPrincipal({ tenantId: "tenant-1" });

  await test("keyword 路径 golden queries 全量通过", async () => {
    const retriever = createDemoRetriever();
    const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);
    const { results, passRate } = await evaluateGoldenQuerySet(
      retriever,
      goldenQueries,
      policy,
    );

    for (const result of results) {
      assert.ok(
        result.passed,
        `${result.id} 未通过：missingTables=${result.missingTables.join(",")} missingColumns=${result.missingColumns.join(",")}`,
      );
    }
    assert.equal(passRate, 1);
  });

  await test("vector 路径 golden queries 全量通过", async () => {
    const { indexer, retriever } = createMetadataStack({
      qdrantUrl: "",
      embeddingProvider: new DeterministicEmbeddingProvider(),
    });
    await indexer.rebuildWithAliasSwap(DEMO_SCHEMA_DOCUMENTS);

    const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);
    const { results, passRate } = await evaluateGoldenQuerySet(
      retriever,
      goldenQueries,
      policy,
    );

    for (const result of results) {
      assert.ok(
        result.passed,
        `${result.id} 未通过：missingTables=${result.missingTables.join(",")} missingColumns=${result.missingColumns.join(",")}`,
      );
    }
    assert.equal(passRate, 1);
  });
}
