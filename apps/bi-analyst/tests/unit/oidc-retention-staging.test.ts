import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OidcAuthProvider,
  normalizeDiscoveryUrl,
  createLocalOidcDiscoveryStub,
} from "../../src/auth/oidc-auth-provider.js";
import { createTestJwtFixture } from "../helpers/jwt-fixture.js";
import { InMemorySessionStore } from "../../src/session/store.js";
import { AuthError } from "../../src/auth/principal.js";
import { resolveAuditRetentionMs } from "../../src/audit/sink.js";
import { bootstrapRuntime } from "../../src/bootstrap/index.js";
import {
  ensureStagingMockAuth,
  resetStagingMockAuthForTests,
} from "../../src/auth/staging-mock-auth.js";
import { test, section } from "../helpers/runner.js";

export async function testOidcAndRetention() {
  section("OIDC discovery + audit retention");

  await test("normalizeDiscoveryUrl 补全 well-known", () => {
    assert.equal(
      normalizeDiscoveryUrl("https://idp.example.com"),
      "https://idp.example.com/.well-known/openid-configuration",
    );
    assert.equal(
      normalizeDiscoveryUrl(
        "https://idp.example.com/.well-known/openid-configuration",
      ),
      "https://idp.example.com/.well-known/openid-configuration",
    );
  });

  await test("OidcAuthProvider 用 discovery stub + 内联 JWKS 验签", async () => {
    const issuer = "https://idp.test.local/";
    const fixture = await createTestJwtFixture({
      issuer,
      audience: "bi-analyst",
    });
    const sessionStore = new InMemorySessionStore();
    const provider = new OidcAuthProvider({
      discoveryUrl: issuer,
      audience: "bi-analyst",
      issuer,
      sessionStore,
      discoveryDocument: createLocalOidcDiscoveryStub({
        issuer,
        jwksUri: "https://idp.test.local/jwks",
      }),
      jwks: fixture.jwks,
    });
    const token = await fixture.sign({
      sub: "user-oidc",
      tenant_id: "tenant-1",
      roles: ["analyst"],
    });
    const principal = await provider.authenticate({
      authorization: `Bearer ${token}`,
    });
    assert.equal(principal.subjectId, "user-oidc");
    sessionStore.registerOrValidate(principal, "sess-1", "policy-v1");
    await provider.validateSession(principal, "sess-1");
    const again = sessionStore.get("tenant-1", "user-oidc", "sess-1");
    assert.ok(again);
  });

  await test("OidcAuthProvider discovery HTTP 失败 → unauthenticated", async () => {
    const provider = new OidcAuthProvider({
      discoveryUrl: "https://missing.example",
      fetchImpl: (async () =>
        new Response("nope", { status: 404 })) as typeof fetch,
    });
    await assert.rejects(
      () => provider.getDiscovery(),
      (err: AuthError) => err.code === "unauthenticated",
    );
  });

  await test("AUDIT_RETENTION_DAYS 解析", () => {
    assert.equal(
      resolveAuditRetentionMs({ AUDIT_RETENTION_DAYS: "14" }, 7),
      14 * 24 * 60 * 60 * 1000,
    );
    assert.equal(resolveAuditRetentionMs({}, 7), 7 * 24 * 60 * 60 * 1000);
  });
}

export async function testSingleMachineStagingBootstrap() {
  section("Single-machine staging Profile (L4)");

  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const registryPath = path.join(root, "config/datasources.staging-acc.yaml");
  const policyPath = path.join(root, "config/policies.staging-acc.json");

  await test("BI_SINGLE_MACHINE_STAGING + mock auth + InMemory retriever", async () => {
    resetStagingMockAuthForTests();
    const mock = await ensureStagingMockAuth();
    const certRoot = mkdtempSync(path.join(tmpdir(), "bi-staging-ca-"));
    const caPath = path.join(certRoot, "ca.pem");
    writeFileSync(caPath, "UNIT TEST CA\n", "utf8");
    try {
      const result = bootstrapRuntime({
        APP_ENV: "staging",
        BI_SINGLE_MACHINE_STAGING: "1",
        BI_STAGING_MOCK_AUTH: "1",
        BI_STAGING_MOCK_ADMIN_KEY: "unit-staging-admin-key-2026-08-18",
        BI_ALLOW_INMEMORY_RETRIEVER: "1",
        BI_ALLOW_ENV_SECRETS: "1",
        BI_MYSQL_TLS_CA_PATH: caPath,
        BI_PG_TLS_CA_PATH: caPath,
        DATASOURCE_REGISTRY_PATH: registryPath,
        POLICY_CONFIG_PATH: policyPath,
        AUTH_JWKS_JSON: JSON.stringify(mock.jwks),
        AUTH_ISSUER: mock.issuer,
        AUTH_AUDIENCE: mock.audience,
        USE_FAKE_EMBEDDINGS: "true",
      });
      assert.equal(result.config.environment, "staging");
      assert.equal(result.profile.isLocal, false);
      assert.ok(result.profile.executorRegistry);
      assert.ok(result.profile.dataSourceRegistry.get("sales_mysql"));
      assert.ok(result.profile.dataSourceRegistry.get("analytics_pg"));
      assert.equal(
        result.profile.schemaRetriever.constructor.name,
        "VectorSchemaRetriever",
      );
      assert.ok(result.profile.auditSink.retentionMs);
      const token = await mock.issueToken();
      const principal = await result.profile.authProvider.authenticate({
        authorization: `Bearer ${token}`,
      });
      assert.equal(principal.subjectId, "user-dev");
      result.localResources?.db.close();
    } finally {
      rmSync(certRoot, { recursive: true, force: true });
      resetStagingMockAuthForTests();
    }
  });

  await test("staging 缺 InMemory 回退且无 Qdrant 时 fail closed", () => {
    resetStagingMockAuthForTests();
    assert.throws(() =>
      bootstrapRuntime({
        APP_ENV: "staging",
        BI_SINGLE_MACHINE_STAGING: "1",
        AUTH_JWKS_URL: "https://auth.example/jwks.json",
        DATASOURCE_REGISTRY_PATH: registryPath,
        POLICY_CONFIG_PATH: policyPath,
      }),
    );
  });
}
