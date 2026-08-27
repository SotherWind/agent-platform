import assert from "node:assert/strict";
import { createTestPrincipal } from "../helpers/principal.js";
import {
  HttpPolicyProvider,
  createHttpPolicyProviderFromEnv,
} from "../../src/policy/http-policy-provider.js";
import { InMemoryPolicyProvider } from "../../src/policy/policy-provider.js";
import { AppError } from "../../src/errors/app-error.js";
import { test, section } from "../helpers/runner.js";

export async function testHttpPolicyProvider() {
  section("HttpPolicyProvider (远程策略服务客户端)");

  await test("成功拉取并归一化策略", async () => {
    const provider = new HttpPolicyProvider({
      baseUrl: "https://policy.test",
      fetchImpl: async (url) => {
        assert.match(String(url), /\/v1\/policies\/tenant-1\/user-a$/);
        return new Response(
          JSON.stringify({
            policyVersion: "9",
            roles: ["analyst"],
            allowedDataSourceIds: ["sales_mysql"],
            allowedTables: ["orders"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const policy = await provider.loadPolicy(
      createTestPrincipal({ subjectId: "user-a", tenantId: "tenant-1" }),
    );
    assert.equal(policy.policyVersion, "9");
    assert.deepEqual(policy.allowedDataSourceIds, ["sales_mysql"]);
    assert.deepEqual(policy.allowedTables, ["orders"]);
  });

  await test("HTTP 失败且无 fallback 时 fail closed", async () => {
    const provider = new HttpPolicyProvider({
      baseUrl: "https://policy.test",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    await assert.rejects(
      () =>
        provider.loadPolicy(
          createTestPrincipal({ subjectId: "u", tenantId: "t" }),
        ),
      (err: unknown) => err instanceof AppError && err.statusCode === 502,
    );
  });

  await test("失败时可降级到 fallback", async () => {
    const fallback = new InMemoryPolicyProvider([
      {
        subjectId: "u",
        tenantId: "t",
        policyVersion: "fallback",
        roles: ["viewer"],
        allowedDataSourceIds: ["ecommerce_sqlite"],
      },
    ]);
    const provider = new HttpPolicyProvider({
      baseUrl: "https://policy.test",
      fallback,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    const policy = await provider.loadPolicy(
      createTestPrincipal({ subjectId: "u", tenantId: "t" }),
    );
    assert.equal(policy.policyVersion, "fallback");
  });

  await test("createHttpPolicyProviderFromEnv 读取 POLICY_SERVICE_URL", () => {
    assert.equal(
      createHttpPolicyProviderFromEnv({}),
      null,
    );
    const p = createHttpPolicyProviderFromEnv({
      POLICY_SERVICE_URL: "https://policy.example",
      POLICY_SERVICE_PATH: "/policies/{tenantId}/{subjectId}",
    });
    assert.ok(p instanceof HttpPolicyProvider);
  });
}
