import assert from "node:assert/strict";
import {
  InMemorySlowQueryRecorder,
  maybeRecordSlowQuery,
} from "../../src/runtime/slow-query.js";
import {
  assessMysqlExplain,
  assessPostgresExplain,
  assessOracleExplain,
  assessSqlServerShowplan,
} from "../../src/datasource/explain-cost.js";
import { compileLogicalQueryToMysql } from "../../src/query-plan/dialect-compiler.js";
import { compileCertifiedMetric } from "../../src/semantic/sql-compiler.js";
import type { MetricDefinition } from "../../src/semantic/metric-registry.js";
import { test, section } from "../helpers/runner.js";

const sampleMetric: MetricDefinition = {
  metric: "order_count",
  version: 1,
  label: "订单数",
  datasourceId: "sales_mysql",
  status: "certified",
  owner: "retail",
  factTable: "orders",
  entityKey: "id",
  measure: { field: "id", aggregation: "count", additive: true },
  timeDimension: "created_at",
  timezone: "Asia/Shanghai",
  unit: "count",
  defaultFilters: [],
  dimensions: [{ name: "status", table: "orders", column: "status" }],
  synonyms: [],
  joinGraph: [],
  requireTimeRange: false,
};

export async function testPhaseDRemaining() {
  section("Phase D/E 方言编译 + 慢查 + EXPLAIN 评估");

  await test("LogicalQuery 编译为 MySQL 反引号", () => {
    const compiled = compileLogicalQueryToMysql({
      source: "sales_mysql",
      measures: [{ ref: "orders.amount", aggregation: "sum" }],
      dimensions: [{ ref: "orders.status" }],
      filters: [],
    });
    assert.equal(compiled.ok, true);
    assert.match(compiled.sql!, /SUM\(`orders`\.`amount`\)/i);
    assert.match(compiled.sql!, /FROM `orders`/i);
  });

  await test("certified 指标按 dialectFamily=mysql 编译", () => {
    const result = compileCertifiedMetric({
      metric: sampleMetric,
      dimensions: ["status"],
      dialectFamily: "mysql",
    });
    assert.equal(result.ok, true, result.reason);
    assert.match(result.sql!, /`orders`/);
    assert.equal(result.dialectFamily, "mysql");
  });

  await test("MySQL EXPLAIN type=ALL 无 WHERE 拒绝", () => {
    const cost = assessMysqlExplain(
      [{ table: "orders", type: "ALL", rows: 10000 }],
      {
        originalSql: "SELECT id, amount FROM orders",
        rejectUnfilteredScan: true,
      },
    );
    assert.equal(cost.allowed, false);
  });

  await test("PostgreSQL Seq Scan 无 WHERE 拒绝", () => {
    const cost = assessPostgresExplain(
      [{ "QUERY PLAN": "Seq Scan on orders  (cost=0.00..100.00)" }],
      {
        originalSql: "SELECT id FROM orders",
        rejectUnfilteredScan: true,
      },
    );
    assert.equal(cost.allowed, false);
  });

  await test("Oracle full scan plan 拒绝", () => {
    const cost = assessOracleExplain(
      [{ PLAN_TABLE_OUTPUT: "| TABLE ACCESS FULL | orders |" }],
      { originalSql: "SELECT id FROM orders", rejectUnfilteredScan: true },
    );
    assert.equal(cost.allowed, false);
  });

  await test("SQL Server scan plan 拒绝", () => {
    const cost = assessSqlServerShowplan(
      [{ StmtText: "|--Table Scan(OBJECT:([dbo].[orders]))" }],
      { originalSql: "SELECT id FROM orders", rejectUnfilteredScan: true },
    );
    assert.equal(cost.allowed, false);
  });

  await test("慢查采样仅记录超阈值", () => {
    const recorder = new InMemorySlowQueryRecorder();
    maybeRecordSlowQuery(recorder, {
      id: "1",
      tenantId: "t1",
      subjectId: "u1",
      requestId: "r1",
      durationMs: 200,
      createdAt: new Date().toISOString(),
    });
    maybeRecordSlowQuery(recorder, {
      id: "2",
      tenantId: "t1",
      subjectId: "u1",
      requestId: "r2",
      durationMs: 1500,
      sqlPreview: "SELECT * FROM orders",
      explainSummary: "type=ALL",
      createdAt: new Date().toISOString(),
    });
    const items = recorder.list({ tenantId: "t1", minDurationMs: 1000 });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.requestId, "r2");
    assert.ok(items[0]!.explainSummary);
  });
}
