import assert from "node:assert/strict";
import { validateSql } from "../../src/datasource/sql-validator.js";
import {
  buildDeterministicRetailAggregateSql,
  buildSqlIntentGuidance,
  normalizeGeneratedSql,
} from "../../src/tools/generate_sql.js";
import { test, section } from "../helpers/runner.js";

export async function testSqlValidator() {
  section("SQL 校验器 (validateSql)");

  await test("允许合法 SELECT", () => {
    const r = validateSql("SELECT city, COUNT(*) FROM users GROUP BY city");
    assert.equal(r.valid, true);
    assert.ok(r.normalizedSql);
  });

  await test("MySQL readonly date function CURDATE is allowed", () => {
    const r = validateSql(
      "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-01') AS month_start FROM orders WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
      {
        dialectFamily: "mysql",
        allowedTables: ["orders"],
        allowedColumns: { orders: ["created_at"] },
      },
    );
    assert.equal(r.valid, true, r.reason);
  });

  await test("certified time bucket functions are allowed per dialect", () => {
    const sqlite = validateSql(
      "SELECT strftime('%Y-%m', created_at) AS time_month, COUNT(id) FROM orders GROUP BY strftime('%Y-%m', created_at)",
      { dialectFamily: "sqlite", allowedTables: ["orders"] },
    );
    const mysql = validateSql(
      "SELECT CONCAT(YEAR(created_at), '-Q', QUARTER(created_at)) AS time_quarter, COUNT(id) FROM orders GROUP BY CONCAT(YEAR(created_at), '-Q', QUARTER(created_at))",
      { dialectFamily: "mysql", allowedTables: ["orders"] },
    );
    assert.equal(sqlite.valid, true, sqlite.reason);
    assert.equal(mysql.valid, true, mysql.reason);
  });

  await test("normalize generated SQL fence", () => {
    assert.equal(
      normalizeGeneratedSql("```sql\nSELECT COUNT(*) FROM orders;\n```") ,
      "SELECT COUNT(*) FROM orders;",
    );
    assert.equal(
      normalizeGeneratedSql("SELECT COUNT(*) FROM orders;```") ,
      "SELECT COUNT(*) FROM orders;",
    );
  });

  await test("SQL intent guidance keeps city and multi-metric semantics", () => {
    const guidance = buildSqlIntentGuidance(
      "\u7edf\u8ba1\u6bcf\u4e2a\u57ce\u5e02\u7684\u7528\u6237\u6570\u91cf\u548c\u8ba2\u5355\u603b\u91d1\u989d",
      {
        tables: [
          { name: "users", columns: [{ name: "id" }, { name: "city" }] },
          { name: "orders", columns: [{ name: "id" }, { name: "amount" }] },
        ],
      },
    );
    assert.ok(
      guidance.some(
        (hint) => hint.includes("users.city") && hint.includes("GROUP BY"),
      ),
    );
    assert.ok(guidance.some((hint) => hint.includes("COUNT(DISTINCT users.id)")));
    assert.ok(guidance.some((hint) => hint.includes("SUM(orders.amount)")));
  });

  await test("deterministic retail aggregate preserves requested dimensions", () => {
    const sql = buildDeterministicRetailAggregateSql(
      "\u7edf\u8ba1\u6bcf\u4e2a\u57ce\u5e02\u7684\u7528\u6237\u6570\u91cf\u548c\u8ba2\u5355\u603b\u91d1\u989d",
      {
        tables: [
          { name: "users", columns: [{ name: "id" }, { name: "city" }] },
          {
            name: "orders",
            columns: [
              { name: "id" },
              { name: "user_id" },
              { name: "amount" },
            ],
          },
        ],
      },
    );
    assert.ok(sql);
    assert.match(sql, /users\.city/i);
    assert.match(sql, /COUNT\(DISTINCT users\.id\)/i);
    assert.match(sql, /SUM\(orders\.amount\)/i);
    assert.match(sql, /GROUP BY users\.city/i);
  });

  await test("拒绝 UPDATE", () => {
    const r = validateSql("UPDATE users SET city = '测试' WHERE id = 1");
    assert.equal(r.valid, false);
    assert.match(r.reason!, /SELECT|副作用|非 SELECT/i);
  });

  await test("拒绝 CREATE / DROP / DELETE", () => {
    assert.equal(validateSql("CREATE TABLE t (id INT)").valid, false);
    assert.equal(validateSql("DROP TABLE users").valid, false);
    assert.equal(validateSql("DELETE FROM users").valid, false);
  });

  await test("拒绝多语句", () => {
    const r = validateSql("SELECT 1; SELECT 2");
    assert.equal(r.valid, false);
    assert.match(r.reason!, /多语句/);
  });

  await test("拒绝 SELECT INTO", () => {
    const r = validateSql("SELECT * INTO backup FROM users");
    assert.equal(r.valid, false);
  });

  await test("无 LIMIT 时自动包裹行数限制", () => {
    const r = validateSql("SELECT * FROM orders");
    assert.equal(r.valid, true);
    assert.match(r.normalizedSql!, /LIMIT\s+10000/i);
  });

  await test("已有 LIMIT 时不重复包裹", () => {
    const r = validateSql("SELECT * FROM orders LIMIT 100");
    assert.equal(r.valid, true);
    assert.match(r.normalizedSql!, /LIMIT\s+100/i);
    assert.doesNotMatch(r.normalizedSql!, /__limited__/);
  });

  await test("Oracle 无分页时使用 FETCH FIRST", () => {
    const r = validateSql("SELECT * FROM orders", {
      dialectFamily: "oracle",
      maxRows: 25,
    });
    assert.equal(r.valid, true);
    assert.match(r.normalizedSql!, /FETCH FIRST 25 ROWS ONLY/i);
    assert.doesNotMatch(r.normalizedSql!, /\bLIMIT\b/i);
  });

  await test("T-SQL 无分页时使用 TOP", () => {
    const r = validateSql("SELECT * FROM orders", {
      dialectFamily: "tsql",
      maxRows: 25,
    });
    assert.equal(r.valid, true);
    assert.match(r.normalizedSql!, /SELECT TOP 25/i);
    assert.doesNotMatch(r.normalizedSql!, /\bLIMIT\b/i);
  });

  await test("越权表访问被拒绝", () => {
    const r = validateSql("SELECT * FROM secret_table", {
      allowedTables: ["users", "orders"],
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /secret_table/);
  });

  await test("AST: 越权列被拒绝", () => {
    const r = validateSql("SELECT password FROM users", {
      allowedTables: ["users"],
      allowedColumns: { users: ["id", "city"] },
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /password/);
    assert.equal(r.failureKind, "permission_denied");
  });

  await test("AST: CTE 深度超限被拒绝", () => {
    const r = validateSql(
      "WITH a AS (WITH b AS (WITH c AS (SELECT city FROM users) SELECT * FROM c) SELECT * FROM b) SELECT * FROM a",
      { maxCteDepth: 2, allowedTables: ["users"] },
    );
    assert.equal(r.valid, false);
    assert.equal(r.failureKind, "cost_rejected");
  });

  await test("AST: 无过滤明细扫描被拒绝", () => {
    const r = validateSql("SELECT id, amount FROM orders", {
      allowedTables: ["orders"],
      requireFilterTables: ["orders"],
    });
    assert.equal(r.valid, false);
    assert.equal(r.failureKind, "cost_rejected");
  });

  await test("AST: 未授权函数被拒绝", () => {
    const r = validateSql("SELECT sleep(1)");
    assert.equal(r.valid, false);
    assert.match(r.reason!, /sleep|危险|未授权/i);
  });
}
