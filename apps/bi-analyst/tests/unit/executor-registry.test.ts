import assert from "node:assert/strict";
import {
  createExecutorRegistry,
  ExecutorRegistry,
} from "../../src/datasource/executor-registry.js";
import {
  attachLiveExecutors,
  buildSqliteExecutorRegistry,
} from "../../src/datasource/executor-factory.js";
import type { SqlExecutor } from "../../src/datasource/types.js";
import { InMemoryDataSourceRegistry } from "../../src/datasource/registry.js";
import { resolveCapabilities } from "../../src/datasource/capabilities.js";
import { TestSecretProvider } from "../../src/datasource/secrets.js";
import { createTestDb, cleanupDb } from "../helpers/db.js";
import { bootstrapRuntime } from "../../src/bootstrap/index.js";
import { test, section } from "../helpers/runner.js";

function fakeExecutor(tag: string): SqlExecutor {
  return {
    async execute() {
      return {
        rows: [{ tag }],
        columns: ["tag"],
        isEmpty: false,
        stats: { durationMs: 1, rowCount: 1 },
      };
    },
    async healthCheck() {
      return { healthy: true, latencyMs: 0 };
    },
    async close() {},
  };
}

export async function testExecutorRegistry() {
  section("ExecutorRegistry (Phase D)");

  await test("按 dataSourceId 精确解析", () => {
    const reg = createExecutorRegistry([
      { id: "ds_mysql", executor: fakeExecutor("mysql") },
      { id: "ds_pg", executor: fakeExecutor("pg") },
    ]);
    assert.equal(reg.has("ds_mysql"), true);
    assert.deepEqual(reg.listIds().sort(), ["ds_mysql", "ds_pg"]);
  });

  await test("未注册且无 default 时 fail closed", () => {
    const reg = new ExecutorRegistry();
    reg.register("a", fakeExecutor("a"));
    assert.throws(() => reg.resolve("missing"), /未注册/);
  });

  await test("default 回退", async () => {
    const def = fakeExecutor("default");
    const reg = createExecutorRegistry(
      [{ id: "a", executor: fakeExecutor("a") }],
      def,
    );
    const ex = reg.resolve("unknown");
    const result = await ex.execute(
      {
        sql: "SELECT 1",
        dataSourceId: "unknown",
        tenantId: "t",
        timeoutMs: 1000,
      },
      new AbortController().signal,
    );
    assert.equal(result.rows[0]?.tag, "default");
  });

  await test("tryResolve 未命中返回 null", () => {
    const reg = new ExecutorRegistry();
    assert.equal(reg.tryResolve("x"), null);
  });

  await test("live executor fails closed when Registry credentials are incomplete", async () => {
    const sourceRegistry = InMemoryDataSourceRegistry.fromConfigs([
      {
        id: "pg_missing_user",
        label: "PG",
        domain: "test",
        productType: "PostgreSQL",
        dialectFamily: "postgresql",
        supportStatus: "experimental",
        connection: {
          host: "127.0.0.1",
          port: 5432,
          database: "test",
          secretRef: { provider: "test", key: "PG_PASSWORD" },
        },
        exposedSchemas: ["public"],
        capabilities: resolveCapabilities("postgresql"),
      },
    ]);
    await assert.rejects(
      () =>
        attachLiveExecutors(new ExecutorRegistry(), {
          dataSourceRegistry: sourceRegistry,
          secretProvider: new TestSecretProvider({ PG_PASSWORD: "secret" }),
          environment: "staging",
        }),
      /requires host, database and user/,
    );
  });

  await test("buildSqliteExecutorRegistry 注册 canonical id", async () => {
    const { db, dbPath } = createTestDb();
    try {
      const reg = buildSqliteExecutorRegistry({
        db,
        dataSourceId: "ecommerce_sqlite",
      });
      assert.ok(reg.has("ecommerce_sqlite"));
      const ex = reg.resolve("ecommerce_sqlite");
      const result = await ex.execute(
        {
          sql: "SELECT COUNT(*) AS cnt FROM users",
          dataSourceId: "ecommerce_sqlite",
          tenantId: "t",
          timeoutMs: 2000,
        },
        new AbortController().signal,
      );
      assert.equal(result.error ?? null, null);
      assert.equal(result.isEmpty, false);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  await test("本地 bootstrap 装配 executorRegistry", () => {
    const prev = process.env.APP_ENV;
    process.env.APP_ENV = "test";
    try {
      const boot = bootstrapRuntime();
      assert.ok(boot.profile.executorRegistry);
      assert.ok(boot.profile.executorRegistry!.has("ecommerce_sqlite"));
      boot.localResources?.db.close();
    } finally {
      if (prev === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = prev;
    }
  });
}
