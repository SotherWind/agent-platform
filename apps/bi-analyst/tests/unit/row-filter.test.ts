import assert from "node:assert/strict";
import { applyRowFilters } from "../../src/policy/row-filter-rewrite.js";
import { SqliteExecutor } from "../../src/datasource/executors/sqlite.js";
import { createTestDb, cleanupDb } from "../helpers/db.js";
import { test, section } from "../helpers/runner.js";

export async function testRowFilterRewrite() {
  section("行级过滤改写 (rowFilters)");

  await test("追加等值谓词并参数绑定", () => {
    const result = applyRowFilters(
      "SELECT city FROM users",
      [{ table: "users", column: "city", operator: "=", values: ["北京"] }],
      { allowedTables: ["users"] },
    );
    assert.equal(result.ok, true);
    assert.match(result.sql!, /users\.city\s*=\s*\?/i);
    assert.deepEqual(result.params, ["北京"]);
  });

  await test("CTE 查询拒绝注入", () => {
    const result = applyRowFilters(
      "WITH t AS (SELECT city FROM users) SELECT * FROM t",
      [{ table: "users", column: "city", operator: "=", values: ["北京"] }],
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /CTE|UNION/i);
  });

  await test("nested, derived, and correlated subqueries fail closed", () => {
    const predicate = [
      { table: "users", column: "city", operator: "=" as const, values: ["北京"] },
    ];
    const attacks = [
      "SELECT city, (SELECT COUNT(*) FROM orders) AS total FROM users",
      "SELECT x.city FROM (SELECT city FROM users) x",
      "SELECT u.city FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",
    ];
    for (const sql of attacks) {
      const result = applyRowFilters(sql, predicate);
      assert.equal(result.ok, false, sql);
      assert.match(result.reason ?? "", /subquer|derived/i);
    }
  });

  await test("aliases, comments, strings, and quoted identifiers cannot confuse injection", () => {
    const result = applyRowFilters(
      `SELECT u.city, 'SELECT users WHERE' AS note
       FROM "users" AS u /* WHERE users.city = '上海' */
       ORDER BY u.city`,
      [{ table: "users", column: "city", operator: "=", values: ["北京"] }],
      { allowedTables: ["users"] },
    );
    assert.equal(result.ok, true);
    assert.match(result.sql ?? "", /u\.city\s*=\s*\?/i);
    assert.deepEqual(result.params, ["北京"]);
  });

  await test("执行器应用 rowFilters 后仅返回过滤行", async () => {
    const { db, dbPath } = createTestDb();
    try {
      const executor = new SqliteExecutor({
        db,
        dataSourceId: "test",
        enableExplainCost: false,
        allowedTables: ["users"],
      });
      const result = await executor.execute(
        {
          sql: "SELECT city FROM users",
          dataSourceId: "test",
          tenantId: "t1",
          timeoutMs: 2000,
          rowFilters: [
            {
              table: "users",
              column: "city",
              operator: "=",
              values: ["北京"],
            },
          ],
        },
        new AbortController().signal,
      );
      assert.equal(result.isEmpty, false);
      assert.ok(result.rows.every((r) => r.city === "北京"));
    } finally {
      cleanupDb(db, dbPath);
    }
  });
}
