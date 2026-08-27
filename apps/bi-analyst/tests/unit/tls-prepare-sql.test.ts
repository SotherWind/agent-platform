import assert from "node:assert/strict";
import {
  resolveTlsOptions,
  toMysqlSslConfig,
  toPostgresSslConfig,
} from "../../src/datasource/tls.js";
import {
  prepareExecutableSql,
  toDialectPlaceholders,
} from "../../src/datasource/prepare-sql.js";
import { test, section } from "../helpers/runner.js";

export async function testTlsAndPrepareSql() {
  section("TLS 选项与 prepareExecutableSql");

  await test("resolveTlsOptions：ssl 关闭返回 undefined", () => {
    assert.equal(resolveTlsOptions({ ssl: false }), undefined);
    assert.equal(resolveTlsOptions({}), undefined);
  });

  await test("resolveTlsOptions：默认校验证书", () => {
    const tls = resolveTlsOptions({ ssl: true });
    assert.equal(tls?.enabled, true);
    assert.equal(tls?.rejectUnauthorized, true);
    assert.deepEqual(toMysqlSslConfig(tls), { rejectUnauthorized: true });
    assert.deepEqual(toPostgresSslConfig(tls), { rejectUnauthorized: true });
  });

  await test("staging/production 禁止关闭证书校验", () => {
    assert.throws(
      () =>
        resolveTlsOptions({
          ssl: true,
          rejectUnauthorized: false,
          requireVerified: true,
        }),
      /禁止关闭 TLS/,
    );
  });

  await test("toDialectPlaceholders：PG / Oracle / T-SQL", () => {
    assert.equal(
      toDialectPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", "mysql"),
      "SELECT * FROM t WHERE a = ? AND b = ?",
    );
    assert.equal(
      toDialectPlaceholders(
        "SELECT * FROM t WHERE a = ? AND b = ?",
        "postgresql",
      ),
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
    assert.equal(
      toDialectPlaceholders("SELECT * FROM t WHERE a = ?", "oracle"),
      "SELECT * FROM t WHERE a = :1",
    );
    assert.equal(
      toDialectPlaceholders("SELECT * FROM t WHERE a = ?", "tsql"),
      "SELECT * FROM t WHERE a = @p1",
    );
  });

  await test("prepareExecutableSql：MySQL rowFilters 用 ?", () => {
    const prepared = prepareExecutableSql({
      sql: "SELECT city FROM users",
      dialectFamily: "mysql",
      allowedTables: ["users"],
      rowFilters: [
        { table: "users", column: "city", operator: "=", values: ["北京"] },
      ],
    });
    assert.equal(prepared.ok, true);
    assert.match(prepared.sql!, /users\.city\s*=\s*\?/i);
    assert.deepEqual(prepared.params, ["北京"]);
  });

  await test("prepareExecutableSql：PostgreSQL rowFilters 用 $n", () => {
    const prepared = prepareExecutableSql({
      sql: "SELECT city FROM users",
      dialectFamily: "postgresql",
      allowedTables: ["users"],
      rowFilters: [
        { table: "users", column: "city", operator: "=", values: ["北京"] },
      ],
    });
    assert.equal(prepared.ok, true);
    assert.match(prepared.sql!, /users\.city\s*=\s*\$1/i);
    assert.deepEqual(prepared.params, ["北京"]);
  });
}
