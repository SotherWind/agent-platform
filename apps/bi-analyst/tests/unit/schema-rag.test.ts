import assert from "node:assert/strict";
import {
  InMemorySchemaRetriever,
  retrieveRelevantSchema,
} from "../../src/metadata/retriever.js";
import { assembleSchema } from "../../src/metadata/schema-assembler.js";
import { DEMO_SCHEMA_DOCUMENTS } from "../../src/metadata/demo-documents.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { test, section } from "../helpers/runner.js";

export async function testSchemaRag() {
  section("Schema RAG + 字段精简");

  const retriever = new InMemorySchemaRetriever(DEMO_SCHEMA_DOCUMENTS);
  const policy = createDefaultAccessPolicy(createTestPrincipal());

  await test("问「北京用户订单总额」命中 city, amount, user_id", async () => {
    const query = "北京用户订单总额";
    const retrieved = await retrieveRelevantSchema(
      retriever,
      query,
      policy,
    );
    const schema = assembleSchema({
      datasourceId: retrieved.datasourceId,
      dialectFamily: retrieved.dialectFamily,
      documents: retrieved.documents,
      policy,
    });

    const allColumns = schema.tables.flatMap((t) =>
      t.columns.map((c) => `${t.name}.${c.name}`),
    );

    assert.ok(allColumns.some((c) => c.endsWith(".city")), "应包含 city");
    assert.ok(allColumns.some((c) => c.endsWith(".amount")), "应包含 amount");
    assert.ok(
      allColumns.some((c) => c.endsWith(".user_id")),
      "应包含 user_id (join key)",
    );
  });

  await test("RAG assembly keeps column_group dimensions", async () => {
    const docs = [
      {
        id: "ds:test",
        docType: "datasource" as const,
        datasourceId: "test",
        domain: "retail",
        dialectFamily: "sqlite" as const,
        reviewStatus: "approved" as const,
        content: "source",
      },
      {
        id: "test.users",
        docType: "table" as const,
        datasourceId: "test",
        domain: "retail",
        dialectFamily: "sqlite" as const,
        table: "users",
        reviewStatus: "approved" as const,
        content: "users",
      },
      {
        id: "test.users.city",
        docType: "column_group" as const,
        datasourceId: "test",
        domain: "retail",
        dialectFamily: "sqlite" as const,
        table: "users",
        column: "city",
        fieldRole: "dimension" as const,
        reviewStatus: "approved" as const,
        content: "city",
      },
    ];
    const retrieved = await retrieveRelevantSchema(
      new InMemorySchemaRetriever(docs),
      "city",
      createDefaultAccessPolicy(createTestPrincipal(), ["test"]),
    );
    const schema = assembleSchema({
      datasourceId: retrieved.datasourceId,
      dialectFamily: retrieved.dialectFamily,
      documents: retrieved.documents,
    });
    assert.ok(
      schema.tables.some((table) =>
        table.columns.some((column) => column.name === "city"),
      ),
    );
  });

  await test("给 LLM 的 schema 字段数受控（≤40/表）", async () => {
    const retrieved = await retrieveRelevantSchema(
      retriever,
      "订单分析",
      policy,
    );
    const schema = assembleSchema({
      datasourceId: retrieved.datasourceId,
      dialectFamily: retrieved.dialectFamily,
      documents: retrieved.documents,
      policy,
    });
    for (const table of schema.tables) {
      assert.ok(
        table.columns.length <= 40,
        `${table.name} 字段数 ${table.columns.length} 超过 40`,
      );
    }
  });

  await test("pii/sensitive 字段不进入 schema", async () => {
    const docs = [
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
    const customRetriever = new InMemorySchemaRetriever(docs);
    const retrieved = await retrieveRelevantSchema(
      customRetriever,
      "用户手机号",
      policy,
    );
    const schema = assembleSchema({
      datasourceId: retrieved.datasourceId,
      dialectFamily: retrieved.dialectFamily,
      documents: retrieved.documents,
      policy,
    });
    const cols = schema.tables.flatMap((t) => t.columns.map((c) => c.name));
    assert.ok(!cols.includes("phone"), "pii 字段 phone 不应进入 schema");
  });

  await test("未审核元数据不可检索", async () => {
    const docs = DEMO_SCHEMA_DOCUMENTS.map((d) =>
      d.id === "ecommerce_sqlite.users.city"
        ? { ...d, reviewStatus: "draft" as const }
        : d,
    );
    const customRetriever = new InMemorySchemaRetriever(docs);
    const hits = await customRetriever.search(
      "北京 城市",
      { docType: "column", datasourceId: "ecommerce_sqlite", limit: 10 },
      policy,
    );
    assert.ok(
      !hits.some((h) => h.column === "city"),
      "draft 状态的 city 不应被检索",
    );
  });
}
