import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestPrincipal } from "../helpers/principal.js";
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

  await test("禁止字段不进入 assembled schema", async () => {
    const fixturePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/evaluation/forbidden-fields.json",
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
      cases: Array<{
        id: string;
        query: string;
        forbiddenColumns: string[];
      }>;
    };

    const { InMemorySchemaRetriever, retrieveRelevantSchema } = await import(
      "../../src/metadata/retriever.js"
    );
    const { assembleSchema } = await import(
      "../../src/metadata/schema-assembler.js"
    );

    const docsWithPii = [
      ...DEMO_SCHEMA_DOCUMENTS,
      {
        id: "ecommerce_sqlite.users.phone",
        docType: "column" as const,
        datasourceId: "ecommerce_sqlite",
        domain: "retail",
        dialectFamily: "sqlite" as const,
        table: "users",
        column: "phone",
        sensitivity: "pii" as const,
        fieldRole: "pii" as const,
        reviewStatus: "approved" as const,
        content: "手机号",
      },
    ];
    const piiRetriever = new InMemorySchemaRetriever(docsWithPii);
    const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);

    for (const c of fixture.cases) {
      const retrieved = await retrieveRelevantSchema(
        piiRetriever,
        c.query,
        policy,
      );
      const schema = assembleSchema({
        datasourceId: retrieved.datasourceId,
        dialectFamily: retrieved.dialectFamily,
        documents: retrieved.documents,
        policy,
      });
      const cols = schema.tables.flatMap((t) =>
        t.columns.map((col) => col.name),
      );
      for (const forbidden of c.forbiddenColumns) {
        assert.ok(
          !cols.includes(forbidden),
          `${c.id}: 禁止字段 ${forbidden} 不应进入 schema`,
        );
      }
    }
  });
}
