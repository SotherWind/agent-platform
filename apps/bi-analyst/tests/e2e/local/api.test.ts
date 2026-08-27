import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { bootstrapRuntime } from "../../../src/bootstrap/index.js";
import { createAppServer } from "../../../src/api/server.js";
import { generateSqlTool } from "../../../src/tools/generate_sql.js";
import { test, section } from "../../helpers/runner.js";
import { InMemoryDataSourceRegistry } from "../../../src/datasource/registry.js";
import { resolveCapabilities } from "../../../src/datasource/capabilities.js";
import { AuthError } from "../../../src/auth/principal.js";
import type { BootstrapResult } from "../../../src/bootstrap/runtime-common.js";

async function withServer<T>(
  fn: (baseUrl: string, app: ReturnType<typeof createAppServer>) => Promise<T>,
  configure?: (bootstrap: BootstrapResult) => void,
): Promise<T> {
  const bootstrap = bootstrapRuntime({ APP_ENV: "test" });
  configure?.(bootstrap);
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

async function requestWithoutCompletingBody(
  baseUrl: string,
  headers: Record<string, string>,
  initialChunk?: string,
): Promise<{ status: number; elapsedMs: number }> {
  const url = new URL("/api/analyze", baseUrl);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      url,
      { method: "POST", headers },
      (response) => {
        response.resume();
        response.once("end", () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            elapsedMs: Date.now() - started,
          });
          req.destroy();
        });
      },
    );
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
    req.flushHeaders();
    if (initialChunk) req.write(initialChunk);
  });
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
    await withServer(async (baseUrl, app) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "ok");
      assert.equal(body.environment, "test");

      const live = await fetch(`${baseUrl}/live`);
      assert.equal(live.status, 200);
      const ready = await fetch(`${baseUrl}/ready`);
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).status, "ready");

      app.profile.dataSourceRegistry = InMemoryDataSourceRegistry.fromConfigs([
        ...app.profile.dataSourceRegistry.list(),
        {
          id: "missing_executor",
          label: "Missing executor",
          domain: "test",
          productType: "PostgreSQL",
          dialectFamily: "postgresql",
          supportStatus: "verified",
          connection: {},
          exposedSchemas: ["public"],
          capabilities: resolveCapabilities("postgresql"),
        },
      ]);
      const notReady = await fetch(`${baseUrl}/ready`);
      assert.equal(notReady.status, 503);
      const notReadyBody = await notReady.json();
      assert.equal(notReadyBody.status, "not_ready");
      assert.deepEqual(notReadyBody.checks.executors.missing, ["missing_executor"]);
      await app.close();
      await app.close();
    });
  });

  await test("POST /api/analyze rejects forged identity fields", async () => {
    await withServer(async (baseUrl) => {
      const { status, body } = await postJson(baseUrl, "/api/analyze", {
        query: "test",
        userId: "attacker",
      });
      assert.equal(status, 401);
      assert.equal(body.code, "forged_identity");
    });
  });

  await test("request body limits fail closed before allocation", async () => {
    await withServer(
      async (baseUrl) => {
        const oversized = await fetch(`${baseUrl}/api/analyze`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-subject-id": "user-test",
            "x-tenant-id": "tenant-1",
          },
          body: JSON.stringify({ query: "x".repeat(256) }),
        });
        assert.equal(oversized.status, 413);

        const slow = await requestWithoutCompletingBody(
          baseUrl,
          {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "x-subject-id": "user-test",
            "x-tenant-id": "tenant-1",
          },
          '{"query":"',
        );
        assert.equal(slow.status, 408);
      },
      (bootstrap) => {
        bootstrap.config.maxRequestBodyBytes = 64;
        bootstrap.config.requestBodyTimeoutMs = 50;
      },
    );
  });

  await test("authentication rejects a stalled body before reading it", async () => {
    await withServer(
      async (baseUrl) => {
        const response = await requestWithoutCompletingBody(baseUrl, {
          "content-type": "application/json",
          "content-length": "1000000",
        });
        assert.equal(response.status, 401);
        assert.ok(response.elapsedMs < 750);
      },
      (bootstrap) => {
        bootstrap.config.requestBodyTimeoutMs = 1_000;
        bootstrap.profile.authProvider = {
          async authenticate() {
            throw new AuthError("Missing bearer token", "unauthenticated");
          },
        };
      },
    );
  });

  await test("POST /api/analyze returns trace metadata", async () => {
    await withServer(async (baseUrl) => {
      const { status, body } = await postJson(baseUrl, "/api/analyze", {
        query: "GMV",
      });
      assert.equal(status, 200);
      assert.ok(body.meta?.requestId);
      assert.ok(body.meta?.traceId);
      assert.ok(body.finalAnswer);
      assert.equal(body.needsClarification, false);
      assert.ok(!String(body.finalAnswer).includes("Execution error"));
      assert.equal(body.meta.dataFreshness.status, "fresh");
      assert.equal(body.meta.queryPath, "metric");
    });
  });

  await test("enterprise feedback, metric governance and traceparent", async () => {
    await withServer(async (baseUrl) => {
      const analyzed = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-subject-id": "user-test",
          "x-tenant-id": "tenant-1",
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        },
        body: JSON.stringify({ query: "GMV" }),
      });
      const analyzedBody = await analyzed.json();
      assert.equal(analyzed.status, 200);
      assert.equal(analyzedBody.meta.traceId, "0123456789abcdef0123456789abcdef");

      const feedback = await fetch(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-subject-id": "user-test",
          "x-tenant-id": "tenant-1",
        },
        body: JSON.stringify({
          requestId: analyzedBody.meta.requestId,
          rating: "negative",
          comment: "需要人工复核",
          correctedSql: "SELECT SUM(amount) FROM orders",
        }),
      });
      assert.equal(feedback.status, 201);
      const feedbackBody = await feedback.json();
      assert.equal(feedbackBody.feedback.rating, "negative");

      const replay = await fetch(`${baseUrl}/api/feedback/replay`, {
        headers: {
          "x-subject-id": "reviewer",
          "x-tenant-id": "tenant-1",
          "x-roles": "BI_EVAL_REVIEWER",
        },
      });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).replayableCases, 1);

      const metrics = await fetch(`${baseUrl}/api/semantic/metrics`, {
        headers: { "x-subject-id": "user-test", "x-tenant-id": "tenant-1" },
      });
      assert.equal(metrics.status, 200);
      assert.ok((await metrics.json()).metrics.length >= 5);

      const governance = await fetch(`${baseUrl}/api/semantic/metrics?governance=1`, {
        headers: {
          "x-subject-id": "reviewer",
          "x-tenant-id": "tenant-1",
          "x-roles": "BI_EVAL_REVIEWER",
        },
      });
      assert.equal(governance.status, 200);
      assert.ok(Array.isArray((await governance.json()).governance.issues));
    });
  });

  await test("durable async analysis job lifecycle", async () => {
    await withServer(async (baseUrl) => {
      const created = await postJson(baseUrl, "/api/analyze/jobs", { query: "GMV" });
      assert.equal(created.status, 202);
      const jobId = created.body.jobId;
      assert.ok(jobId);
      let current = created.body;
      for (let i = 0; i < 100 && current.status !== "completed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const polled = await fetch(`${baseUrl}/api/analyze/jobs/${encodeURIComponent(jobId)}`, {
          headers: { "x-subject-id": "user-test", "x-tenant-id": "tenant-1" },
        });
        assert.equal(polled.status, 200);
        current = await polled.json();
      }
      assert.equal(current.status, "completed");
      assert.equal(current.result.needsClarification, false);
    });
  });

  await test("POST /api/analyze returns trace metadata for generated SQL", async () => {
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

  await test("GET /api/models and /api/history", async () => {
    await withServer(async (baseUrl) => {
      const models = await fetch(`${baseUrl}/api/models`, {
        headers: {
          "x-subject-id": "user-test",
          "x-tenant-id": "tenant-1",
        },
      });
      assert.equal(models.status, 200);
      const modelsBody = await models.json();
      assert.ok(modelsBody.active?.id);

      const history = await fetch(`${baseUrl}/api/history`, {
        headers: {
          "x-subject-id": "user-test",
          "x-tenant-id": "tenant-1",
        },
      });
      assert.equal(history.status, 200);
      const historyBody = await history.json();
      assert.ok(Array.isArray(historyBody.items));
    });
  });

  await test("POST /api/analyze/stream emits lifecycle and terminal events", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/analyze/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-subject-id": "user-test",
          "x-tenant-id": "tenant-1",
        },
        body: JSON.stringify({ query: "GMV" }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const body = await response.text();
      assert.match(body, /event: status/);
      assert.match(body, /"phase":"started"/);
      assert.match(body, /"phase":"running"/);
      assert.match(body, /"phase":"completed"/);
      assert.match(body, /event: done/);
      assert.match(body, /"ok":true/);
    });
  });
}
