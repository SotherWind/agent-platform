import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import { bootstrapRuntime } from "../../../src/bootstrap/index.js";
import { createAppServer } from "../../../src/api/server.js";
import { generateSqlTool } from "../../../src/tools/generate_sql.js";
import { test, section } from "../../helpers/runner.js";

async function withServer<T>(
  fn: (baseUrl: string, app: ReturnType<typeof createAppServer>) => Promise<T>,
): Promise<T> {
  const bootstrap = bootstrapRuntime({ APP_ENV: "test" });
  const app = createAppServer(bootstrap);
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl, app);
  } finally {
    await app.close();
  }
}

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-subject-id": "user-test",
      "x-tenant-id": "tenant-1",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

export async function testE2eLocalApi() {
  section("E2E Local API");

  await test("GET /health", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "ok");
      assert.equal(body.environment, "test");
    });
  });

  await test("POST /api/analyze 拒绝伪造身份字段", async () => {
    await withServer(async (baseUrl) => {
      const { status, body } = await postJson(baseUrl, "/api/analyze", {
        query: "test",
        userId: "attacker",
      });
      assert.equal(status, 401);
      assert.equal(body.code, "forged_identity");
    });
  });

  await test("POST /api/analyze 返回 trace 元数据", async () => {
    const originalInvoke = generateSqlTool.invoke.bind(generateSqlTool);
    generateSqlTool.invoke = (async () =>
      "SELECT u.city, SUM(o.amount) AS total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.city = '北京' GROUP BY u.city") as typeof generateSqlTool.invoke;

    try {
      await withServer(async (baseUrl) => {
        const { status, body } = await postJson(baseUrl, "/api/analyze", {
          query: "北京用户订单总额",
        });
        assert.equal(status, 200);
        assert.ok(body.meta?.requestId);
        assert.ok(body.meta?.traceId);
        assert.ok(body.finalAnswer);
        assert.equal(body.meta.dataFreshness.status, "fresh");
      });
    } finally {
      generateSqlTool.invoke = originalInvoke;
    }
  });
}
