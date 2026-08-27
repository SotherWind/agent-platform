import assert from "node:assert/strict";
import { buildLogicalQuery } from "../../src/query-plan/builder.js";
import {
  compileLogicalQueryToSqlite,
  compileLogicalQueryToMysql,
  compileLogicalQueryToPostgresql,
} from "../../src/query-plan/dialect-compiler.js";
import { validateLogicalQueryPolicy } from "../../src/query-plan/policy-validator.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { test, section } from "../helpers/runner.js";

export async function testLogicalQuery() {
  section("LogicalQuery (Phase C)");

  await test("构建并编译单表聚合查询", () => {
    const built = buildLogicalQuery({
      source: "ecommerce_sqlite",
      measures: [{ ref: "orders.amount", aggregation: "sum" }],
      dimensions: [{ ref: "orders.status" }],
      filters: [
        { field: "orders.status", operator: "in", value: ["paid", "shipped"] },
      ],
    });
    assert.equal(built.ok, true);
    const compiled = compileLogicalQueryToSqlite(built.query!, {
      defaultTable: "orders",
    });
    assert.equal(compiled.ok, true);
    assert.match(compiled.sql!, /SUM\("orders"\."amount"\)/i);
    assert.match(compiled.sql!, /GROUP BY/i);
    assert.deepEqual(compiled.params, ["paid", "shipped"]);
  });

  await test("无权数据源被拒绝", () => {
    const policy = createDefaultAccessPolicy(createTestPrincipal(), ["ds-a"]);
    const result = validateLogicalQueryPolicy(
      {
        source: "ds-b",
        measures: [{ ref: "x", aggregation: "count" }],
        dimensions: [],
        filters: [],
      },
      policy,
    );
    assert.equal(result.ok, false);
  });

  await test("缺少时间范围返回澄清", () => {
    const policy = createDefaultAccessPolicy(createTestPrincipal());
    const result = validateLogicalQueryPolicy(
      {
        source: "ecommerce_sqlite",
        measures: [{ ref: "amount", aggregation: "sum" }],
        dimensions: [],
        filters: [],
      },
      policy,
      { requireTimeRange: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.clarification?.reason, "missing_time_range");
    assert.ok(
      result.clarification?.options?.some((o) => o.id === "range.this_fiscal_year"),
    );
  });

  await test("同一 LogicalQuery 可编译为 MySQL / PostgreSQL", () => {
    const query = {
      source: "sales",
      measures: [{ ref: "orders.amount", aggregation: "sum" as const }],
      dimensions: [{ ref: "orders.status" }],
      filters: [
        { field: "orders.status", operator: "in" as const, value: ["paid"] },
      ],
    };
    const mysql = compileLogicalQueryToMysql(query, { defaultTable: "orders" });
    const pg = compileLogicalQueryToPostgresql(query, {
      defaultTable: "orders",
    });
    assert.equal(mysql.ok, true);
    assert.equal(pg.ok, true);
    assert.match(mysql.sql!, /`orders`\.`amount`/);
    assert.match(pg.sql!, /"orders"\."amount"/);
    assert.deepEqual(mysql.params, ["paid"]);
    assert.deepEqual(pg.params, ["paid"]);
  });

  await test("时间粒度在各方言中编译为安全时间桶", () => {
    const query = {
      source: "sales",
      measures: [{ ref: "orders.id", aggregation: "count" as const }],
      dimensions: [],
      filters: [],
      timeGrain: {
        field: "orders.created_at",
        grain: "month" as const,
      },
    };
    const sqlite = compileLogicalQueryToSqlite(query, {
      defaultTable: "orders",
    });
    const mysql = compileLogicalQueryToMysql(query, {
      defaultTable: "orders",
    });
    const pg = compileLogicalQueryToPostgresql(query, {
      defaultTable: "orders",
    });
    assert.equal(sqlite.ok, true, sqlite.reason);
    assert.equal(mysql.ok, true, mysql.reason);
    assert.equal(pg.ok, true, pg.reason);
    assert.match(sqlite.sql!, /strftime\('%Y-%m'/i);
    assert.match(mysql.sql!, /DATE_FORMAT\(.*%Y-%m/i);
    assert.match(pg.sql!, /TO_CHAR\(.*YYYY-MM/i);
    assert.match(sqlite.sql!, /GROUP BY/i);
    assert.match(sqlite.sql!, /ORDER BY/i);
  });
}
