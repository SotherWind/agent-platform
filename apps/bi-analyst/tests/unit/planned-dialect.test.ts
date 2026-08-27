import assert from "node:assert/strict";
import {
  compileLogicalQueryToOracle,
  compileLogicalQueryToTsql,
} from "../../src/query-plan/dialect-compiler.js";
import { createExecutor } from "../../src/datasource/executors/index.js";
import { PlannedDialectExecutor } from "../../src/datasource/executors/planned-stub.js";
import {
  mapProductToDialect,
  PRODUCT_SUPPORT_STATUS,
  resolveCapabilities,
} from "../../src/datasource/capabilities.js";
import { validateSql } from "../../src/datasource/sql-validator.js";
import { test, section } from "../helpers/runner.js";

export async function testPlannedDialects() {
  section("Phase D: dialects (Oracle / T-SQL / MariaDB)");

  await test("MariaDB 映射 mysql 且 experimental", () => {
    assert.equal(mapProductToDialect("MariaDB"), "mysql");
    assert.equal(PRODUCT_SUPPORT_STATUS.MariaDB, "experimental");
  });

  await test("Oracle / SQLServer 映射与 experimental 状态", () => {
    assert.equal(mapProductToDialect("Oracle"), "oracle");
    assert.equal(mapProductToDialect("SQLServer"), "tsql");
    assert.equal(PRODUCT_SUPPORT_STATUS.Oracle, "experimental");
    assert.equal(PRODUCT_SUPPORT_STATUS.SQLServer, "experimental");
  });

  await test("Oracle / T-SQL LogicalQuery 分页编译", () => {
    const query = {
      source: "erp",
      measures: [{ ref: "orders.amount", aggregation: "sum" as const }],
      dimensions: [{ ref: "orders.status" }],
      filters: [],
      limit: 5,
    };
    const oracle = compileLogicalQueryToOracle(query, {
      defaultTable: "orders",
    });
    const tsql = compileLogicalQueryToTsql(query, { defaultTable: "orders" });
    assert.equal(oracle.ok, true);
    assert.equal(tsql.ok, true);
    assert.match(oracle.sql!, /FETCH FIRST 5 ROWS ONLY/);
    assert.match(tsql.sql!, /FETCH NEXT 5 ROWS ONLY/);
    assert.match(oracle.sql!, /"ORDERS"|"orders"/i);
    assert.match(tsql.sql!, /\[orders\]/);
  });

  await test("无客户端时 PlannedDialectExecutor 明确拒绝", async () => {
    const executor = createExecutor({
      config: {
        id: "erp_oracle",
        label: "Oracle",
        domain: "finance",
        productType: "Oracle",
        dialectFamily: "oracle",
        connection: {},
        exposedSchemas: ["ADS"],
        capabilities: resolveCapabilities("oracle"),
        supportStatus: "experimental",
      },
    });
    assert.ok(executor instanceof PlannedDialectExecutor);
    const result = await executor.execute(
      {
        sql: "SELECT 1 FROM dual",
        dataSourceId: "erp_oracle",
        tenantId: "t1",
        timeoutMs: 1000,
      },
      new AbortController().signal,
    );
    assert.equal(result.failureKind, "policy_rejected");
    assert.match(result.error ?? "", /未注入|oracledb|客户端/);
  });

  await test("oracle/tsql AST 拒绝 DML", () => {
    for (const dialect of ["oracle", "tsql"] as const) {
      const ok = validateSql(
        "SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status",
        { dialectFamily: dialect, allowedTables: ["orders"] },
      );
      assert.equal(ok.valid, true, `${dialect}: ${ok.reason}`);
      const bad = validateSql("DELETE FROM orders", { dialectFamily: dialect });
      assert.equal(bad.valid, false);
    }
  });
}
