import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapProductToDialect,
  resolveCapabilities,
  assertExecutableSupportStatus,
  PRODUCT_SUPPORT_STATUS,
} from "../../src/datasource/capabilities.js";
import {
  dialectPromptHints,
  renderPagination,
  quoteIdentifier,
} from "../../src/datasource/dialect.js";
import { loadDataSourceRegistryFromYaml } from "../../src/datasource/registry-loader.js";
import {
  routeDataSource,
  routeDataSourceAsync,
} from "../../src/datasource/router.js";
import { InMemoryDataSourceRegistry } from "../../src/datasource/registry.js";
import { createSqliteDataSourceConfig } from "../../src/datasource/types.js";
import { InMemorySchemaRetriever } from "../../src/metadata/retriever.js";
import type { SchemaDocument } from "../../src/metadata/types.js";
import {
  CircuitBreaker,
  TenantConcurrencyLimiter,
} from "../../src/datasource/pool.js";
import { MysqlExecutor } from "../../src/datasource/executors/mysql.js";
import { PostgresExecutor } from "../../src/datasource/executors/postgresql.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { validateSql } from "../../src/datasource/sql-validator.js";
import { test, section } from "../helpers/runner.js";

export async function testDialectAndRouter() {
  section("Phase D: dialect / capabilities / router");

  await test("productType 映射到方言族", () => {
    assert.equal(mapProductToDialect("MySQL"), "mysql");
    assert.equal(mapProductToDialect("PostgreSQL"), "postgresql");
    assert.equal(mapProductToDialect("SQLite"), "sqlite");
    assert.equal(mapProductToDialect("SQLServer"), "tsql");
  });

  await test("能力与分页渲染", () => {
    const mysql = resolveCapabilities("mysql");
    assert.equal(mysql.identifierQuote, "`");
    assert.match(renderPagination("mysql", 10, 20), /LIMIT 10 OFFSET 20/);
    assert.match(renderPagination("tsql", 10, 20), /FETCH NEXT 10/);
    assert.equal(quoteIdentifier("postgresql", "users"), '"users"');
    assert.equal(quoteIdentifier("mysql", "users"), "`users`");
    assert.ok(dialectPromptHints("mysql").some((h) => /DATE_FORMAT/.test(h)));
  });

  await test("生产仅允许 production-certified", () => {
    assert.throws(() =>
      assertExecutableSupportStatus("experimental", "production"),
    );
    assert.doesNotThrow(() =>
      assertExecutableSupportStatus("production-certified", "production"),
    );
    assert.doesNotThrow(() =>
      assertExecutableSupportStatus("experimental", "staging"),
    );
    assert.throws(() => assertExecutableSupportStatus("planned", "staging"));
    assert.equal(PRODUCT_SUPPORT_STATUS.SQLite, "verified");
  });

  await test("YAML Registry 加载示例配置", () => {
    const filePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/datasources.example.yaml",
    );
    const registry = loadDataSourceRegistryFromYaml(filePath);
    assert.ok(registry.get("ecommerce_sqlite"));
    assert.ok(registry.get("sales_mysql"));
    assert.equal(registry.get("sales_mysql")?.dialectFamily, "mysql");
    assert.equal(registry.get("analytics_pg")?.supportStatus, "experimental");
  });

  await test("YAML Registry resolves CA files relative to the registry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bi-registry-"));
    try {
      writeFileSync(path.join(root, "ca.pem"), "TEST CA\n", "utf8");
      const registryPath = path.join(root, "datasources.yaml");
      writeFileSync(
        registryPath,
        [
          "datasources:",
          "  - id: tls_mysql",
          "    label: TLS MySQL",
          "    domain: retail",
          "    productType: MySQL",
          "    connection:",
          "      host: mysql.local",
          "      database: retail",
          "      user: bi",
          "      ssl: true",
          "      rejectUnauthorized: true",
          "      caFile: ./ca.pem",
          "    exposedSchemas: [retail]",
          "",
        ].join("\n"),
        "utf8",
      );

      const registry = loadDataSourceRegistryFromYaml(registryPath);
      const connection = registry.get("tls_mysql")?.connection;
      assert.equal(connection?.ssl, true);
      assert.equal(connection?.rejectUnauthorized, true);
      assert.equal(connection?.ca, "TEST CA\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await test("跨源意图触发澄清", () => {
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, [
      "ecommerce_sqlite",
      "sales_mysql",
    ]);
    const registry = InMemoryDataSourceRegistry.fromConfigs([
      createSqliteDataSourceConfig("ecommerce_sqlite", ":memory:"),
      {
        ...createSqliteDataSourceConfig("sales_mysql", ":memory:"),
        id: "sales_mysql",
        label: "销售 MySQL",
        domain: "retail",
        productType: "MySQL",
        dialectFamily: "mysql",
        capabilities: resolveCapabilities("mysql"),
        supportStatus: "experimental",
      },
    ]);
    const result = routeDataSource({
      query: "跨库联合查询订单和财务收入",
      principal,
      policy,
      registry,
    });
    assert.equal(result.ok, false);
    assert.equal(result.clarification?.reason, "cross_source_query");
  });

  await test("query dialect mention selects matching source", () => {
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, [
      "ecommerce_sqlite",
      "sales_mysql",
    ]);
    const registry = InMemoryDataSourceRegistry.fromConfigs([
      createSqliteDataSourceConfig("ecommerce_sqlite", ":memory:"),
      {
        ...createSqliteDataSourceConfig("sales_mysql", ":memory:"),
        id: "sales_mysql",
        label: "Sales MySQL",
        productType: "MySQL",
        dialectFamily: "mysql",
        capabilities: resolveCapabilities("mysql"),
        supportStatus: "experimental",
      },
    ]);
    const result = routeDataSource({
      query: "Count all orders in MySQL",
      principal,
      policy,
      registry,
    });
    assert.equal(result.ok, true);
    assert.equal(result.dataSourceId, "sales_mysql");
  });

  await test("workspace default source keeps business queries source-agnostic", () => {
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, [
      "ecommerce_sqlite",
      "sales_mysql",
    ]);
    const registry = InMemoryDataSourceRegistry.fromConfigs([
      createSqliteDataSourceConfig("ecommerce_sqlite", ":memory:"),
      {
        ...createSqliteDataSourceConfig("sales_mysql", ":memory:"),
        id: "sales_mysql",
        label: "Sales MySQL",
        productType: "MySQL",
        dialectFamily: "mysql",
        capabilities: resolveCapabilities("mysql"),
        supportStatus: "experimental",
      },
    ]);
    const result = routeDataSource({
      query: "给我查询一下张三这个月的销售额",
      principal,
      policy,
      registry,
      preferredDataSourceId: "sales_mysql",
    });
    assert.equal(result.ok, true);
    assert.equal(result.dataSourceId, "sales_mysql");
    assert.equal(result.confidence, 0.9);
  });

  await test("多源冲突低分差时澄清", () => {
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, ["a", "b"]);
    const registry = InMemoryDataSourceRegistry.fromConfigs([
      {
        ...createSqliteDataSourceConfig("a", ":memory:"),
        id: "a",
        label: "零售库",
        domain: "retail",
      },
      {
        ...createSqliteDataSourceConfig("b", ":memory:"),
        id: "b",
        label: "另一个零售库",
        domain: "retail",
      },
    ]);
    const result = routeDataSource({
      query: "订单销售分析",
      principal,
      policy,
      registry,
      confidenceThreshold: 0.9,
    });
    assert.equal(result.ok, false);
    assert.equal(result.clarification?.reason, "ambiguous_datasource");
  });

  await test("唯一授权源直接选中", () => {
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, ["only"]);
    const registry = InMemoryDataSourceRegistry.fromConfigs([
      createSqliteDataSourceConfig("only", ":memory:"),
    ]);
    const result = routeDataSource({
      query: "任意问题",
      principal,
      policy,
      registry,
    });
    assert.equal(result.ok, true);
    assert.equal(result.dataSourceId, "only");
    assert.equal(result.confidence, 1);
  });

  await test("向量选源融合：财务文档偏向 finance 源", async () => {
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, [
      "ecommerce_sqlite",
      "analytics_pg",
    ]);
    const registry = InMemoryDataSourceRegistry.fromConfigs([
      {
        ...createSqliteDataSourceConfig("ecommerce_sqlite", ":memory:"),
        domain: "retail",
        label: "电商零售",
      },
      {
        ...createSqliteDataSourceConfig("analytics_pg", ":memory:"),
        id: "analytics_pg",
        domain: "finance",
        label: "财务分析库",
        productType: "PostgreSQL",
        dialectFamily: "postgresql",
        capabilities: resolveCapabilities("postgresql"),
        supportStatus: "experimental",
      },
    ]);
    const docs: SchemaDocument[] = [
      {
        id: "datasource:ecommerce_sqlite",
        docType: "datasource",
        datasourceId: "ecommerce_sqlite",
        domain: "retail",
        dialectFamily: "sqlite",
        reviewStatus: "approved",
        content: "电商零售订单用户商品",
      },
      {
        id: "datasource:analytics_pg",
        docType: "datasource",
        datasourceId: "analytics_pg",
        domain: "finance",
        dialectFamily: "postgresql",
        reviewStatus: "approved",
        content: "财务收入营收总账会计分析 PostgreSQL",
      },
    ];
    const retriever = new InMemorySchemaRetriever(docs);
    const result = await routeDataSourceAsync({
      query: "查一下财务营收和总账收入",
      principal,
      policy,
      registry,
      schemaRetriever: retriever,
      heuristicWeight: 0.35,
      confidenceThreshold: 0.4,
    });
    assert.equal(result.ok, true, result.reason ?? result.clarification?.question);
    assert.equal(result.dataSourceId, "analytics_pg");
    assert.equal(result.scoring, "fused");
  });
}

export async function testMysqlPgExecutorContract() {
  section("Phase D: MySQL/PG executor contract (fake client)");

  await test("MySQL executor 拒绝 DML", async () => {
    const client = {
      async query() {
        return { rows: [], columns: [] };
      },
      async ping() {},
      async end() {},
    };
    const executor = new MysqlExecutor({
      dataSourceId: "sales_mysql",
      client,
    });
    const result = await executor.execute(
      {
        sql: "DELETE FROM orders WHERE id = 1",
        dataSourceId: "sales_mysql",
        tenantId: "t1",
        timeoutMs: 1000,
      },
      new AbortController().signal,
    );
    assert.equal(result.failureKind, "policy_rejected");
  });

  await test("PostgreSQL executor 合法 SELECT", async () => {
    const client = {
      async query() {
        return {
          rows: [{ city: "北京", cnt: 4 }],
          columns: ["city", "cnt"],
        };
      },
      async ping() {},
      async end() {},
    };
    const executor = new PostgresExecutor({
      dataSourceId: "analytics_pg",
      client,
    });
    const result = await executor.execute(
      {
        sql: "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city",
        dataSourceId: "analytics_pg",
        tenantId: "t1",
        timeoutMs: 1000,
      },
      new AbortController().signal,
    );
    assert.equal(result.isEmpty, false);
    assert.equal(result.rows.length, 1);
  });

  await test("MySQL and PostgreSQL abort active queries and fail closed on EXPLAIN", async () => {
    let mysqlCancelled = false;
    const mysqlClient = {
      async query(
        sql: string,
        _params: (string | number)[] = [],
        options: { signal?: AbortSignal } = {},
      ) {
        if (/^EXPLAIN/i.test(sql)) throw new Error("permission denied");
        return await new Promise<{ rows: Record<string, unknown>[]; columns: string[] }>(
          (_resolve, reject) => {
            const cancel = () => {
              mysqlCancelled = true;
              reject(new Error("Query cancelled"));
            };
            options.signal?.addEventListener("abort", cancel, { once: true });
          },
        );
      },
      async ping() {},
      async end() {},
    };
    const mysql = new MysqlExecutor({
      dataSourceId: "sales_mysql",
      client: mysqlClient,
      enableExplainCost: false,
    });
    const mysqlController = new AbortController();
    const mysqlPromise = mysql.execute(
      {
        sql: "SELECT city FROM users",
        dataSourceId: "sales_mysql",
        tenantId: "t1",
        timeoutMs: 50,
      },
      mysqlController.signal,
    );
    setTimeout(() => mysqlController.abort(), 5);
    const mysqlResult = await mysqlPromise;
    assert.equal(mysqlCancelled, true);
    assert.equal(mysqlResult.failureKind, "timeout");

    let pgCalls = 0;
    const pgClient = {
      async query(sql: string) {
        pgCalls += 1;
        if (/^EXPLAIN/i.test(sql)) throw new Error("EXPLAIN forbidden");
        return { rows: [{ city: "北京" }], columns: ["city"] };
      },
      async ping() {},
      async end() {},
    };
    const pg = new PostgresExecutor({
      dataSourceId: "analytics_pg",
      client: pgClient,
    });
    const pgResult = await pg.execute(
      {
        sql: "SELECT city FROM users",
        dataSourceId: "analytics_pg",
        tenantId: "t1",
        timeoutMs: 50,
      },
      new AbortController().signal,
    );
    assert.equal(pgResult.failureKind, "cost_rejected");
    assert.equal(pgCalls, 1, "a failed EXPLAIN must not fall through to query execution");
  });

  await test("熔断器在连续失败后开启", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetMs: 60_000 });
    let calls = 0;
    await assert.rejects(() =>
      breaker.exec(async () => {
        calls += 1;
        throw new Error("boom");
      }),
    );
    await assert.rejects(() =>
      breaker.exec(async () => {
        calls += 1;
        throw new Error("boom");
      }),
    );
    await assert.rejects(
      () => breaker.exec(async () => "ok"),
      /熔断/,
    );
    assert.equal(calls, 2);
  });

  await test("租户并发配额生效", async () => {
    const limiter = new TenantConcurrencyLimiter(1);
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = limiter.run("t1", async () => {
      await block;
      return "a";
    });
    await assert.rejects(
      () => limiter.run("t1", async () => "b"),
      /并发/,
    );
    release();
    assert.equal(await first, "a");
  });
}

export async function testDialectConformance() {
  section("Phase D: dialect conformance (validator)");

  for (const dialect of ["mysql", "postgresql", "sqlite"] as const) {
    await test(`${dialect} 允许合法聚合 SELECT`, () => {
      const r = validateSql(
        "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city LIMIT 100",
        { dialectFamily: dialect, allowedTables: ["users"] },
      );
      assert.equal(r.valid, true, r.reason);
    });

    await test(`${dialect} 拒绝 UPDATE`, () => {
      const r = validateSql("UPDATE users SET city = 'x'", {
        dialectFamily: dialect,
      });
      assert.equal(r.valid, false);
    });
  }

  for (const dialect of ["oracle", "tsql"] as const) {
    await test(`${dialect} 允许合法聚合 SELECT（无 LIMIT 子句）`, () => {
      const r = validateSql(
        "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city",
        { dialectFamily: dialect, allowedTables: ["users"] },
      );
      assert.equal(r.valid, true, r.reason);
    });

    await test(`${dialect} 拒绝 UPDATE`, () => {
      const r = validateSql("UPDATE users SET city = 'x'", {
        dialectFamily: dialect,
      });
      assert.equal(r.valid, false);
    });
  }
}
