import assert from "node:assert/strict";
import { validateSql } from "../../src/datasource/sql-validator.js";
import { test, section } from "../helpers/runner.js";

export async function testSqlValidator() {
  section("SQL 校验器 (validateSql)");

  await test("允许合法 SELECT", () => {
    const r = validateSql("SELECT city, COUNT(*) FROM users GROUP BY city");
    assert.equal(r.valid, true);
    assert.ok(r.normalizedSql);
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

  await test("越权表访问被拒绝", () => {
    const r = validateSql("SELECT * FROM secret_table", {
      allowedTables: ["users", "orders"],
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /secret_table/);
  });
}
