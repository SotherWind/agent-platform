#!/usr/bin/env tsx
/**
 * MySQL / PostgreSQL → production-certified 本地门禁。
 *
 * 可编码检查：类型映射、方言编译、Executor 装配、planned stub、能力登记。
 * 不可在本脚本内完成（需运维证据）：云 staging 部署、容量/故障演练、生产 artifact 晋级。
 *
 * 用法：pnpm verify:dialect-cert
 * 退出码：0 = 本地门禁通过（云阻塞项仅打印）；1 = 本地门禁失败
 */
import assert from "node:assert/strict";
import {
  PRODUCT_SUPPORT_STATUS,
  mapProductToDialect,
  resolveCapabilities,
  isAllowedInProduction,
} from "../src/datasource/capabilities.js";
import {
  compileLogicalQueryToMysql,
  compileLogicalQueryToOracle,
  compileLogicalQueryToPostgresql,
  compileLogicalQueryToTsql,
} from "../src/query-plan/dialect-compiler.js";
import { createExecutor } from "../src/datasource/executors/index.js";
import { PlannedDialectExecutor } from "../src/datasource/executors/planned-stub.js";
import type { DataSourceConfig } from "../src/datasource/types.js";

interface GateItem {
  id: string;
  ok: boolean;
  detail: string;
  blocker?: boolean;
}

const sampleQuery = {
  source: "ds",
  measures: [{ ref: "orders.amount", aggregation: "sum" as const }],
  dimensions: [{ ref: "orders.status" }],
  filters: [],
  limit: 10,
};

function check(id: string, fn: () => void): GateItem {
  try {
    fn();
    return { id, ok: true, detail: "pass" };
  } catch (err) {
    return {
      id,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkAsync(id: string, fn: () => Promise<void>): Promise<GateItem> {
  try {
    await fn();
    return { id, ok: true, detail: "pass" };
  } catch (err) {
    return {
      id,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const items: GateItem[] = [];

  items.push(
    check("product_map_mariadb_mysql", () => {
      assert.equal(mapProductToDialect("MariaDB"), "mysql");
      assert.equal(PRODUCT_SUPPORT_STATUS.MariaDB, "experimental");
    }),
  );

  items.push(
    check("product_map_oracle_sqlserver", () => {
      assert.equal(mapProductToDialect("Oracle"), "oracle");
      assert.equal(mapProductToDialect("SQLServer"), "tsql");
      assert.equal(PRODUCT_SUPPORT_STATUS.Oracle, "experimental");
      assert.equal(PRODUCT_SUPPORT_STATUS.SQLServer, "experimental");
    }),
  );

  items.push(
    check("compile_mysql_pg", () => {
      const mysql = compileLogicalQueryToMysql(sampleQuery, {
        defaultTable: "orders",
      });
      const pg = compileLogicalQueryToPostgresql(sampleQuery, {
        defaultTable: "orders",
      });
      assert.equal(mysql.ok, true);
      assert.equal(pg.ok, true);
      assert.match(mysql.sql!, /LIMIT 10/);
      assert.match(pg.sql!, /LIMIT 10/);
    }),
  );

  items.push(
    check("compile_oracle_tsql_pagination", () => {
      const oracle = compileLogicalQueryToOracle(sampleQuery, {
        defaultTable: "orders",
      });
      const tsql = compileLogicalQueryToTsql(sampleQuery, {
        defaultTable: "orders",
      });
      assert.equal(oracle.ok, true);
      assert.equal(tsql.ok, true);
      assert.match(oracle.sql!, /FETCH FIRST 10 ROWS ONLY/);
      assert.match(tsql.sql!, /OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY/);
      assert.match(oracle.sql!, /"orders"/);
      assert.match(tsql.sql!, /\[orders\]/);
    }),
  );

  items.push(
    await checkAsync("oracle_stub_without_client", async () => {
      const config: DataSourceConfig = {
        id: "erp_oracle",
        label: "Oracle",
        domain: "finance",
        productType: "Oracle",
        dialectFamily: "oracle",
        connection: {},
        exposedSchemas: ["ADS"],
        capabilities: resolveCapabilities("oracle"),
        supportStatus: "experimental",
      };
      const executor = createExecutor({ config });
      assert.ok(executor instanceof PlannedDialectExecutor);
      const health = await executor.healthCheck();
      assert.equal(health.healthy, false);
      assert.match(health.message ?? "", /未注入|oracledb|客户端/);
    }),
  );

  items.push(
    check("mysql_pg_oracle_not_production_certified", () => {
      assert.equal(PRODUCT_SUPPORT_STATUS.MySQL, "experimental");
      assert.equal(PRODUCT_SUPPORT_STATUS.PostgreSQL, "experimental");
      assert.equal(PRODUCT_SUPPORT_STATUS.MariaDB, "experimental");
      assert.equal(PRODUCT_SUPPORT_STATUS.Oracle, "experimental");
      assert.equal(isAllowedInProduction("experimental"), false);
      assert.equal(isAllowedInProduction("production-certified"), true);
    }),
  );

  items.push(
    check("capabilities_present", () => {
      assert.equal(resolveCapabilities("oracle").paginationStyle, "rownum");
      assert.equal(resolveCapabilities("tsql").paginationStyle, "offset-fetch");
      assert.equal(resolveCapabilities("mysql").identifierQuote, "`");
    }),
  );

  const blockers: GateItem[] = [
    {
      id: "cloud_staging_deploy",
      ok: false,
      blocker: true,
      detail:
        "需云 staging 部署同一 production artifact，并完成容量/故障/回滚演练",
    },
    {
      id: "mysql_pg_mtls_cloud_evidence",
      ok: false,
      blocker: true,
      detail:
        "本地 Docker TLS/mTLS 已通过；云 RDS/托管库证书与网络策略证据待运维归档",
    },
    {
      id: "production_certified_signoff",
      ok: false,
      blocker: true,
      detail:
        "仅当云 staging 证据齐备后，才可将 MySQL/PG supportStatus 升为 production-certified",
    },
  ];

  const localFailed = items.filter((i) => !i.ok);
  const report = {
    gate: "dialect-certification",
    localPass: localFailed.length === 0,
    localChecks: items,
    cloudBlockers: blockers,
    note:
      "本地门禁通过不等于 production-certified。云阻塞项见 cloudBlockers，勿在文档中假装完成。",
  };

  console.log(JSON.stringify(report, null, 2));

  if (localFailed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
