import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "../../src/agent.js";
import { generateSqlTool } from "../../src/tools/generate_sql.js";
import { test, section } from "../helpers/runner.js";
import { createTestDb, cleanupDb } from "../helpers/db.js";
import { getTestRuntimeProfile } from "../helpers/profile.js";

export async function testSchemaRagIntegration() {
  section("Schema RAG 集成 (graph schemaRag 节点)");

  const { db, dbPath } = createTestDb();

  try {
    await test("graph 使用 RAG schema 而非全量 getSchema", async () => {
      const capturedSchemas: unknown[] = [];
      const originalInvoke = generateSqlTool.invoke.bind(generateSqlTool);

      generateSqlTool.invoke = (async (input) => {
        const payload = input as { schema?: unknown };
        if (payload.schema) capturedSchemas.push(payload.schema);
        return "SELECT u.city, SUM(o.amount) AS total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.city = '北京' GROUP BY u.city";
      }) as typeof generateSqlTool.invoke;

      try {
        const graph = buildGraph({
          db,
          useSchemaRag: true,
          runtimeProfile: getTestRuntimeProfile(),
        });
        const result = await graph.invoke(
          { messages: [new HumanMessage("北京用户订单总额")] },
          { configurable: { thread_id: "integration-schema-rag" } },
        );

        assert.ok(result.retrievedSchema, "应有 retrievedSchema");
        assert.equal(result.queryPath, "rag");
        assert.equal(result.dataSourceId, "ecommerce_sqlite");
        assert.ok(capturedSchemas.length >= 1);

        const schema = capturedSchemas[0] as {
          tables: Array<{ name: string; columns: Array<{ name: string }> }>;
        };
        const cols = schema.tables.flatMap((t) =>
          t.columns.map((c) => `${t.name}.${c.name}`),
        );
        assert.ok(cols.some((c) => c.includes("city")));
        assert.ok(cols.some((c) => c.includes("amount")));
        assert.ok(result.executionResult?.error === undefined || result.executionResult?.isEmpty === false);
      } finally {
        generateSqlTool.invoke = originalInvoke;
      }
    });
  } finally {
    db.close();
    cleanupDb(dbPath);
  }
}
