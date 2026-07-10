import assert from "node:assert/strict";
import { createExecuteCodeTool } from "../../src/tools/execute_code";
import { test, section } from "../helpers/runner";
import { createTestDb, cleanupDb, EXEC_CTX } from "../helpers/db";

export async function testExecuteCode() {
  section("SQL 执行工具 (createExecuteCodeTool)");

  const { db, dbPath } = createTestDb();
  const executeCode = createExecuteCodeTool(db);

  try {
    await test("正常 SELECT：返回行、列和统计信息", async () => {
      const result = await executeCode.invoke({
        sql: "SELECT city, COUNT(*) AS user_count FROM users GROUP BY city ORDER BY user_count DESC",
        executionContext: EXEC_CTX,
        expectedFormat: "chart-ready",
      });
      assert.equal(result.isEmpty, false);
      const columns = result.columns as string[];
      assert.ok(columns.includes("city"));
      assert.ok(columns.includes("user_count"));
      assert.ok(result.rows.length >= 5);
      assert.ok(result.stats && result.stats.rowCount > 0);
      assert.equal(result.error, undefined);
    });

    await test("JOIN 查询：北京用户订单总额", async () => {
      const result = await executeCode.invoke({
        sql: `SELECT u.name, SUM(o.amount) AS total
              FROM users u
              JOIN orders o ON o.user_id = u.id
              WHERE u.city = '北京'
              GROUP BY u.name
              ORDER BY total DESC`,
        executionContext: EXEC_CTX,
        expectedFormat: "chart-ready",
      });
      assert.equal(result.isEmpty, false);
      const rows = result.rows as Record<string, unknown>[];
      const alice = rows.find((r) => r.name === "Alice");
      assert.ok(alice);
      assert.equal(alice.total, 898.99);
    });

    await test("空结果：isEmpty 为 true", async () => {
      const result = await executeCode.invoke({
        sql: "SELECT * FROM users WHERE city = '不存在的城市'",
        executionContext: EXEC_CTX,
        expectedFormat: "chart-ready",
      });
      assert.equal(result.isEmpty, true);
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.columns, []);
      assert.ok(result.stats);
      assert.equal(result.stats!.rowCount, 0);
    });

    await test("非 SELECT 垃圾 SQL：校验器拒绝并脱敏", async () => {
      const result = await executeCode.invoke({
        sql: "SELEC * FORM users",
        executionContext: EXEC_CTX,
        expectedFormat: "chart-ready",
      });
      assert.equal(result.isEmpty, true);
      assert.ok(result.error);
      assert.equal(result.failureKind, "policy_rejected");
      assert.doesNotMatch(result.error!, /SELEC|FORM|SQLITE/i);
    });

    await test("SELECT 语法错误：返回 syntax_error", async () => {
      const result = await executeCode.invoke({
        sql: "SELECT FROM users",
        executionContext: EXEC_CTX,
        expectedFormat: "chart-ready",
      });
      assert.equal(result.isEmpty, true);
      assert.ok(result.error);
      assert.equal(result.failureKind, "syntax_error");
    });

    await test("拒绝非 SELECT：UPDATE 返回 policy_rejected error", async () => {
      const result = await executeCode.invoke({
        sql: "UPDATE users SET city = '测试' WHERE id = 1",
        executionContext: EXEC_CTX,
        expectedFormat: "table",
      });
      assert.equal(result.isEmpty, true);
      assert.ok(result.error);
      assert.equal(result.failureKind, "policy_rejected");
      assert.doesNotMatch(result.error!, /SQLITE|users/i);
    });
  } finally {
    db.close();
    cleanupDb(dbPath);
  }
}
