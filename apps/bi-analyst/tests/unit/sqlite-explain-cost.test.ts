import assert from "node:assert/strict";
import { assessExplainQueryPlan } from "../../src/datasource/explain-cost.js";
import { SqliteExecutor } from "../../src/datasource/executors/sqlite.js";
import { createTestDb, cleanupDb } from "../helpers/db.js";
import { test, section } from "../helpers/runner.js";

export async function testSqliteExplainCost() {
  section("SQLite EXPLAIN 成本门禁");

  await test("无过滤明细 SCAN 被启发式拒绝", () => {
    const result = assessExplainQueryPlan(
      [{ detail: "SCAN orders" }],
      {
        originalSql: "SELECT id, amount FROM orders",
        rejectUnfilteredScan: true,
      },
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /全表扫描|SCAN/i);
  });

  await test("聚合查询允许 SCAN", () => {
    const result = assessExplainQueryPlan(
      [{ detail: "SCAN users" }],
      {
        originalSql: "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city",
        rejectUnfilteredScan: true,
      },
    );
    assert.equal(result.allowed, true);
  });

  await test("带 WHERE 的明细查询允许", () => {
    const result = assessExplainQueryPlan(
      [{ detail: "SCAN orders" }],
      {
        originalSql: "SELECT id, amount FROM orders WHERE status = 'paid'",
        rejectUnfilteredScan: true,
      },
    );
    assert.equal(result.allowed, true);
  });

  await test("执行器对本过滤明细返回 cost_rejected", async () => {
    const { db, dbPath } = createTestDb();
    try {
      const executor = new SqliteExecutor({
        db,
        dataSourceId: "test",
        enableExplainCost: true,
        rejectUnfilteredScan: true,
      });
      const result = await executor.execute(
        {
          sql: "SELECT id, amount, status FROM orders",
          dataSourceId: "test",
          tenantId: "t1",
          timeoutMs: 2000,
        },
        new AbortController().signal,
      );
      assert.equal(result.failureKind, "cost_rejected");
      assert.equal(result.isEmpty, true);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  await test("explain() 返回计划文本", async () => {
    const { db, dbPath } = createTestDb();
    try {
      const executor = new SqliteExecutor({
        db,
        dataSourceId: "test",
        enableExplainCost: false,
      });
      const plan = await executor.explain(
        "SELECT city FROM users WHERE city = '北京'",
      );
      assert.ok(plan.length > 0);
    } finally {
      cleanupDb(db, dbPath);
    }
  });
}
