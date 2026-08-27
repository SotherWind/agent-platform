import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapRuntime } from "../../src/bootstrap/index.js";
import { ConfigError } from "../../src/config/env.js";
import { createTestPrincipal } from "../helpers/principal.js";
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
    assert.ok(result.profile.executorRegistry?.has("ecommerce_sqlite"));
    result.localResources?.db.close();
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

  await test("production rejects short export encryption secrets", () => {
    const registryPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/datasources.example.yaml",
    );
    const policyPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/policies.example.json",
    );
    assert.throws(
      () =>
        bootstrapRuntime({
          APP_ENV: "production",
          QDRANT_URL: "http://127.0.0.1:6333",
          DATASOURCE_REGISTRY_PATH: registryPath,
          AUTH_JWKS_URL: "https://auth.example/jwks.json",
          AUTH_ISSUER: "https://auth.example/",
          AUTH_AUDIENCE: "bi-analyst",
          REDIS_URL: "redis://127.0.0.1:6379",
          AUDIT_DATABASE_URL: "postgresql://bi:test@127.0.0.1:5432/retail",
          EXPORT_ENCRYPTION_SECRET: "too-short",
          HISTORY_ENCRYPTION_SECRET: "test-history-encryption-secret-32chars!",
          POLICY_CONFIG_PATH: policyPath,
        }),
      (error: ConfigError) =>
        error.name === "ConfigError" &&
        error.message.includes("EXPORT_ENCRYPTION_SECRET"),
    );
  });

  await test("production 有必需配置时装配 VectorSchemaRetriever", () => {
    const registryPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/datasources.example.yaml",
    );
    const policyPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/policies.example.json",
    );
    const result = bootstrapRuntime({
      APP_ENV: "production",
      QDRANT_URL: "http://127.0.0.1:6333",
      DATASOURCE_REGISTRY_PATH: registryPath,
      AUTH_JWKS_URL: "https://auth.example/jwks.json",
      AUTH_ISSUER: "https://auth.example/",
      AUTH_AUDIENCE: "bi-analyst",
      REDIS_URL: "redis://127.0.0.1:6379",
      AUDIT_DATABASE_URL: "postgresql://bi:test@127.0.0.1:5432/retail",
      EXPORT_ENCRYPTION_SECRET: "test-export-encryption-secret-32chars!",
      HISTORY_ENCRYPTION_SECRET: "test-history-encryption-secret-32chars!",
      POLICY_CONFIG_PATH: policyPath,
    });
    assert.equal(result.profile.isLocal, false);
    assert.equal(result.profile.schemaRetriever.constructor.name, "VectorSchemaRetriever");
    assert.ok(result.profile.policyProvider);
    assert.ok(result.profile.dataSourceRegistry.get("ecommerce_sqlite"));
    assert.ok(result.profile.productization);
    assert.equal(result.profile.sessionStore.constructor.name, "RedisSessionStore");
    assert.equal(
      result.profile.productization?.exportJobs.constructor.name,
      "RedisExportJobStore",
    );
    assert.equal(
      result.profile.productization?.modelRegistry.constructor.name,
      "RedisModelVersionRegistry",
    );
  });

  await test("production 配置 Vault 时装配 AuditingSecretProvider（内层 Vault）", () => {
    const registryPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/datasources.example.yaml",
    );
    const policyPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/policies.example.json",
    );
    const result = bootstrapRuntime({
      APP_ENV: "production",
      QDRANT_URL: "http://127.0.0.1:6333",
      DATASOURCE_REGISTRY_PATH: registryPath,
      AUTH_JWKS_URL: "https://auth.example/jwks.json",
      AUTH_ISSUER: "https://auth.example/",
      AUTH_AUDIENCE: "bi-analyst",
      REDIS_URL: "redis://127.0.0.1:6379",
      AUDIT_DATABASE_URL: "postgresql://bi:test@127.0.0.1:5432/retail",
      EXPORT_ENCRYPTION_SECRET: "test-export-encryption-secret-32chars!",
      HISTORY_ENCRYPTION_SECRET: "test-history-encryption-secret-32chars!",
      POLICY_CONFIG_PATH: policyPath,
      VAULT_ADDR: "https://vault.example",
      VAULT_TOKEN: "hvs.test",
    });
    assert.equal(
      result.profile.secretProvider.constructor.name,
      "AuditingSecretProvider",
      "生产密钥源默认套 AuditingSecretProvider（内层为 Vault）",
    );
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
