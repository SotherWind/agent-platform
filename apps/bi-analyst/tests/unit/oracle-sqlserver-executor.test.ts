import assert from "node:assert/strict";
import {
  OracleExecutor,
  type OracleQueryClient,
} from "../../src/datasource/executors/oracle.js";
import {
  SqlServerExecutor,
  type SqlServerQueryClient,
} from "../../src/datasource/executors/sqlserver.js";
import { createExecutor } from "../../src/datasource/executors/index.js";
import { PlannedDialectExecutor } from "../../src/datasource/executors/planned-stub.js";
import { toDialectPlaceholders } from "../../src/datasource/placeholders.js";
import { resolveCapabilities } from "../../src/datasource/capabilities.js";
import { PRODUCT_SUPPORT_STATUS } from "../../src/datasource/capabilities.js";
import { test, section } from "../helpers/runner.js";

function memoryClient(
  rows: Record<string, unknown>[] = [{ n: 1 }],
): OracleQueryClient & SqlServerQueryClient {
  return {
    async query(sql, params = []) {
      return {
        rows: rows.map((r) => ({ ...r, _sql: sql, _params: params })),
        columns: Object.keys(rows[0] ?? { n: 1 }),
      };
    },
    async ping() {},
    async end() {},
  };
}

export async function testOracleSqlServerExecutors() {
  section("Oracle / SQLServer Executor (experimental 可注入客户端)");

  await test("产品状态为 experimental（非 production-certified）", () => {
    assert.equal(PRODUCT_SUPPORT_STATUS.Oracle, "experimental");
    assert.equal(PRODUCT_SUPPORT_STATUS.SQLServer, "experimental");
  });

  await test("占位符：oracle :n / tsql @pN", () => {
    assert.equal(
      toDialectPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", "oracle"),
      "SELECT * FROM t WHERE a = :1 AND b = :2",
    );
    assert.equal(
      toDialectPlaceholders("SELECT * FROM t WHERE a = ?", "tsql"),
      "SELECT * FROM t WHERE a = @p1",
    );
  });

  await test("无客户端时仍回退 PlannedDialectExecutor", () => {
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
  });

  await test("注入客户端后走 OracleExecutor：SELECT + 拒 DML", async () => {
    const client = memoryClient([{ amount: 10 }]);
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
      oracleClient: client,
      allowedTables: ["orders"],
    });
    assert.ok(executor instanceof OracleExecutor);

    const ok = await executor.execute(
      {
        sql: "SELECT amount FROM orders",
        dataSourceId: "erp_oracle",
        tenantId: "t1",
        timeoutMs: 2000,
        allowedTables: ["orders"],
      },
      new AbortController().signal,
    );
    assert.equal(ok.error, undefined);
    assert.equal(ok.isEmpty, false);

    const bad = await executor.execute(
      {
        sql: "DELETE FROM orders",
        dataSourceId: "erp_oracle",
        tenantId: "t1",
        timeoutMs: 2000,
      },
      new AbortController().signal,
    );
    assert.equal(bad.failureKind, "policy_rejected");
  });

  await test("SqlServerExecutor：rowFilters 绑定 @pN", async () => {
    let lastSql = "";
    let lastParams: (string | number)[] = [];
    const client: SqlServerQueryClient = {
      async query(sql, params = []) {
        lastSql = sql;
        lastParams = params;
        return { rows: [{ city: "北京" }], columns: ["city"] };
      },
      async ping() {},
      async end() {},
    };
    const executor = new SqlServerExecutor({
      dataSourceId: "crm_mssql",
      client,
      allowedTables: ["users"],
    });
    const result = await executor.execute(
      {
        sql: "SELECT city FROM users",
        dataSourceId: "crm_mssql",
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
    assert.equal(result.error, undefined);
    assert.match(lastSql, /@p1/);
    assert.deepEqual(lastParams, ["北京"]);
  });

  await test("Oracle EXPLAIN PLAN 读取 DBMS_XPLAN", async () => {
    const calls: string[] = [];
    const client: OracleQueryClient = {
      async query(sql) {
        calls.push(sql);
        return {
          rows: [{ PLAN_TABLE_OUTPUT: "TABLE ACCESS FULL orders" }],
          columns: ["PLAN_TABLE_OUTPUT"],
        };
      },
      async ping() {},
      async end() {},
    };
    const executor = new OracleExecutor({
      dataSourceId: "erp",
      client,
      rejectUnfilteredScan: false,
    });
    const plan = await executor.explain("SELECT 1 FROM dual");
    assert.match(plan, /TABLE ACCESS FULL/);
    assert.match(calls[0]!, /EXPLAIN PLAN FOR/);
    assert.match(calls[1]!, /DBMS_XPLAN\.DISPLAY/);
  });

  await test("SQL Server SHOWPLAN 文本可读取", async () => {
    const calls: string[] = [];
    const client: SqlServerQueryClient = {
      async query(sql) {
        calls.push(sql);
        return { rows: [{ plan: "Table Scan" }], columns: ["plan"] };
      },
      async ping() {},
      async end() {},
    };
    const executor = new SqlServerExecutor({
      dataSourceId: "crm",
      client,
      rejectUnfilteredScan: false,
    });
    const plan = await executor.explain("SELECT 1");
    assert.match(plan, /Table Scan/);
    assert.match(calls[0]!, /SHOWPLAN_TEXT ON/);
  });
}
