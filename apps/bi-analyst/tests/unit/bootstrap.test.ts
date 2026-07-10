import assert from "node:assert/strict";
import { bootstrapRuntime } from "../../src/bootstrap/index.js";
import { ConfigError } from "../../src/config/env.js";
import { createTestPrincipal } from "../../src/auth/principal.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import {
  InMemoryDataSourceRegistry,
  requireAuthorizedDataSource,
  RegistryError,
} from "../../src/datasource/registry.js";
import { createSqliteDataSourceConfig } from "../../src/datasource/types.js";
import { test, section } from "../helpers/runner.js";

export async function testBootstrap() {
  section("Composition Root (bootstrap)");

  await test("test 环境装配本地 Profile", () => {
    const result = bootstrapRuntime({ APP_ENV: "test" });
    assert.equal(result.profile.isLocal, true);
    assert.ok(result.localResources?.db);
    assert.ok(result.profile.dataSourceRegistry.list().length >= 1);
    assert.ok(result.profile.schemaRetriever);
  });

  await test("production 缺配置时 fail closed", () => {
    assert.throws(
      () =>
        bootstrapRuntime({
          APP_ENV: "production",
        }),
      (err: ConfigError) => err.name === "ConfigError",
    );
  });

  await test("production 有 QDRANT_URL 时装配 VectorSchemaRetriever", () => {
    const result = bootstrapRuntime({
      APP_ENV: "production",
      QDRANT_URL: "http://127.0.0.1:6333",
      DATASOURCE_REGISTRY_PATH: "/tmp/registry.yaml",
      AUTH_JWKS_URL: "https://auth.example/jwks.json",
    });
    assert.equal(result.profile.isLocal, false);
    assert.equal(result.profile.schemaRetriever.constructor.name, "VectorSchemaRetriever");
  });
}

export async function testRegistry() {
  section("DataSourceRegistry");

  const principal = createTestPrincipal();
  const policy = createDefaultAccessPolicy(principal, ["ds-a"]);
  const registry = InMemoryDataSourceRegistry.fromConfigs([
    createSqliteDataSourceConfig("ds-a", ":memory:"),
    createSqliteDataSourceConfig("ds-b", ":memory:"),
  ]);

  await test("按策略过滤授权数据源", () => {
    const authorized = registry.getAuthorized(principal, policy);
    assert.equal(authorized.length, 1);
    assert.equal(authorized[0]?.id, "ds-a");
  });

  await test("越权数据源被拒绝", () => {
    assert.throws(
      () =>
        requireAuthorizedDataSource(registry, principal, policy, "ds-b"),
      (err: RegistryError) => err.code === "forbidden",
    );
  });
}
