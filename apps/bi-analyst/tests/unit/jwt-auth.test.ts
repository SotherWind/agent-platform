import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JwtAuthProvider,
  extractBearerToken,
} from "../../src/auth/jwt-auth-provider.js";
import { createTestJwtFixture } from "../helpers/jwt-fixture.js";
import { AuthError } from "../../src/auth/principal.js";
import { bootstrapRuntime } from "../../src/bootstrap/index.js";
import { test, section } from "../helpers/runner.js";

export async function testJwtAuth() {
  section("JWT AuthProvider");

  const issuer = "https://auth.test.local";
  const audience = "bi-analyst";
  const fixture = await createTestJwtFixture({ issuer, audience });

  await test("extractBearerToken 解析 Authorization", () => {
    assert.equal(
      extractBearerToken({ authorization: "Bearer abc.def.ghi" }),
      "abc.def.ghi",
    );
    assert.equal(extractBearerToken({}), null);
  });

  await test("有效 JWT 映射为 Principal", async () => {
    const provider = new JwtAuthProvider({
      jwks: fixture.jwks,
      issuer,
      audience,
    });
    const token = await fixture.sign({
      sub: "user-42",
      tenant_id: "tenant-acme",
      roles: ["analyst", "BI_QUERY_DEBUG"],
    });
    const principal = await provider.authenticate({
      authorization: `Bearer ${token}`,
    });
    assert.equal(principal.subjectId, "user-42");
    assert.equal(principal.tenantId, "tenant-acme");
    assert.deepEqual(principal.roles, ["analyst", "BI_QUERY_DEBUG"]);
  });

  await test("缺少 Bearer 抛 unauthenticated", async () => {
    const provider = new JwtAuthProvider({
      jwks: fixture.jwks,
      issuer,
      audience,
    });
    await assert.rejects(
      () => provider.authenticate({}),
      (err: AuthError) => err.code === "unauthenticated",
    );
  });

  await test("缺 tenant_id 抛 unauthenticated", async () => {
    const provider = new JwtAuthProvider({
      jwks: fixture.jwks,
      issuer,
      audience,
    });
    const token = await fixture.sign({ sub: "u1" });
    await assert.rejects(
      () => provider.authenticate({ authorization: `Bearer ${token}` }),
      (err: AuthError) =>
        err.code === "unauthenticated" && /tenant/i.test(err.message),
    );
  });

  await test("过期 token 拒绝", async () => {
    const provider = new JwtAuthProvider({
      jwks: fixture.jwks,
      issuer,
      audience,
    });
    const token = await fixture.sign({ sub: "u1", tenant_id: "t1" }, -10);
    await assert.rejects(
      () => provider.authenticate({ authorization: `Bearer ${token}` }),
      (err: AuthError) => err.code === "unauthenticated",
    );
  });

  await test("错误 issuer 拒绝", async () => {
    const provider = new JwtAuthProvider({
      jwks: fixture.jwks,
      issuer: "https://other.issuer",
      audience,
    });
    const token = await fixture.sign({
      sub: "u1",
      tenant_id: "t1",
    });
    await assert.rejects(
      () => provider.authenticate({ authorization: `Bearer ${token}` }),
      (err: AuthError) => err.code === "unauthenticated",
    );
  });

  await test("production 有 AUTH_JWKS_URL 时装配 JwtAuthProvider", () => {
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
      STATE_VOLUME_PATH: "./data/test-production-state",
      POLICY_CONFIG_PATH: policyPath,
    });
    assert.equal(result.profile.isLocal, false);
    assert.ok(result.profile.authProvider instanceof JwtAuthProvider);
  });
}
