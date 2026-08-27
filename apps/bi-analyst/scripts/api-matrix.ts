/**
 * Black-box API matrix for the local BI runtime.
 *
 * The script intentionally runs the test profile and clears LLM credentials so
 * the metric path is deterministic. The single RAG case stubs SQL generation
 * with a read-only query; no external service or model call is made.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });
process.env.APP_ENV = "test";
process.env.BI_SQLITE_SYNC = "1";
process.env.USE_FAKE_EMBEDDINGS = "true";
// Keep this run offline and deterministic. Metric queries do not need an LLM.
process.env.MODEL_API_KEY = "";
process.env.LLM_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { bootstrapRuntime } = await import("../src/bootstrap/index.js");
const { createAppServer } = await import("../src/api/server.js");
const { generateSqlTool } = await import("../src/tools/generate_sql.js");

type Result = { status: number; headers: Headers; body: unknown };
type RequestOptions = {
  subjectId?: string;
  tenantId?: string;
  roles?: string[];
  rawBody?: string;
};

const failures: string[] = [];
const passed: string[] = [];

// The application intentionally logs every audit event. Keep the matrix
// output readable while retaining the PASS/FAIL lines and final counts.
const originalConsoleInfo = console.info;
console.info = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && /^\[(?:audit|slo|bi-analyst)/.test(first)) {
    return;
  }
  originalConsoleInfo(...args);
};
const originalConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && /^\[(?:audit|slo|bi-analyst)/.test(first)) {
    return;
  }
  originalConsoleWarn(...args);
};
const originalConsoleDebug = console.debug;
console.debug = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && /^\[(?:audit|slo|bi-analyst)/.test(first)) {
    return;
  }
  originalConsoleDebug(...args);
};

function headers(options: RequestOptions = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-subject-id": options.subjectId ?? "user-test",
    "x-tenant-id": options.tenantId ?? "tenant-1",
    ...(options.roles ? { "x-roles": options.roles.join(",") } : {}),
  };
}

async function request(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<Result> {
  const init: RequestInit = { method, headers: headers(options) };
  if (options.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json")
    ? await response.json()
    : await response.text();
  return { status: response.status, headers: response.headers, body: payload };
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

function jsonBody(result: Result): Record<string, any> {
  assert.equal(typeof result.body, "object");
  return result.body as Record<string, any>;
}

function assertAnalyzeOk(result: Result): Record<string, any> {
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.equal(typeof body.finalAnswer, "string");
  assert.ok(body.finalAnswer.length > 0);
  assert.ok(body.meta?.requestId);
  assert.ok(body.meta?.traceId);
  assert.equal(body.needsClarification, false);
  return body;
}

const bootstrap = bootstrapRuntime({ ...process.env, APP_ENV: "test" });
const app = createAppServer(bootstrap);
await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const port = (app.server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;

try {
  await check("health exposes test runtime", async () => {
    const result = await request(baseUrl, "GET", "/health");
    assert.equal(result.status, 200);
    assert.deepEqual(jsonBody(result), {
      status: "ok",
      environment: "test",
      liveDataSourceIds: [],
    });
  });

  let gmvRequestId = "";
  await check("metric happy path returns deterministic total", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", { query: "GMV" }),
    );
    gmvRequestId = body.meta.requestId;
    assert.equal(body.meta.queryPath, "metric");
    assert.equal(body.meta.dataFreshness.status, "fresh");
    assert.equal(body.chartSpec?.type, "table");
    assert.deepEqual(body.chartSpec?.dataset?.rows, [[1699.48]]);
  });

  await check("identical query is permission-scoped cache hit", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", { query: "  GMV  " }),
    );
    assert.equal(body.meta.cacheHit, true);
    assert.notEqual(body.meta.requestId, gmvRequestId);
  });

  await check("dimensions and city filter preserve metric semantics", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", {
        query: "北京各用户订单总额",
      }),
    );
    assert.equal(body.meta.queryPath, "metric");
    assert.equal(body.chartSpec?.type, "bar");
    assert.deepEqual(body.chartSpec?.option?.xAxis?.data, ["Alice", "Frank"]);
    assert.deepEqual(body.chartSpec?.option?.series?.[1]?.data, [898.99, 199.99]);
  });

  await check("Chinese status wording groups certified metric dimensions", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", {
        query: "各订单状态的订单数量占比",
      }),
    );
    assert.equal(body.meta.queryPath, "metric");
    assert.equal(body.chartSpec?.type, "pie");
    const categories = body.chartSpec?.option?.series?.[0]?.data?.map(
      (item: { name: string }) => item.name,
    );
    assert.ok(Array.isArray(categories));
    assert.ok(categories.includes("paid"));
    assert.ok(categories.includes("cancelled"));
  });

  await check("monthly trend query groups by month and selects a line chart", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", {
        query: "按月份统计订单数量，展示趋势",
      }),
    );
    assert.equal(body.meta.queryPath, "metric");
    assert.equal(body.chartSpec?.type, "line");
    const categories = body.chartSpec?.option?.xAxis?.data;
    const series = body.chartSpec?.option?.series?.[0];
    assert.ok(Array.isArray(categories));
    assert.ok(categories.length >= 2);
    assert.equal(series?.type, "line");
    assert.deepEqual(series?.data, [3, 2, 2, 1, 1, 1]);
  });

  await check("time-range query handles empty result without failure", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", {
        query: "最近30天订单总额",
      }),
    );
    assert.equal(body.meta.queryPath, "metric");
    assert.equal(body.chartSpec?.type, "table");
    assert.deepEqual(body.chartSpec?.dataset?.rows, []);
    assert.match(body.finalAnswer, /no data|未查到/i);
  });

  await check("clarification choice is accepted", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", {
        query: "订单总额",
        clarificationChoice: "range.last_30d",
      }),
    );
    assert.equal(body.meta.queryPath, "metric");
    assert.deepEqual(body.chartSpec?.dataset?.rows, []);
  });

  await check("RAG path executes a safe generated SELECT", async () => {
    const originalInvoke = generateSqlTool.invoke.bind(generateSqlTool);
    generateSqlTool.invoke = (async () =>
      "SELECT users.city, COUNT(orders.id) AS order_count FROM users JOIN orders ON orders.user_id = users.id GROUP BY users.city") as typeof generateSqlTool.invoke;
    try {
      const body = assertAnalyzeOk(
        await request(baseUrl, "POST", "/api/analyze", {
          query: "列出每个城市的订单笔数",
        }),
      );
      assert.equal(body.meta.queryPath, "rag");
      assert.ok(body.chartSpec);
      assert.equal(body.meta.dataFreshness.status, "fresh");
      assert.ok(
        body.meta.dataFreshness.warnings.some((warning: string) =>
          /sourceUpdatedAt/.test(warning),
        ),
      );
    } finally {
      generateSqlTool.invoke = originalInvoke;
    }
  });

  await check("session query bypasses global cache and is recorded", async () => {
    const sessionId = "matrix-session";
    const first = assertAnalyzeOk(
      await request(
        baseUrl,
        "POST",
        "/api/analyze",
        { query: "订单数量", sessionId },
        { subjectId: "session-user" },
      ),
    );
    const second = assertAnalyzeOk(
      await request(
        baseUrl,
        "POST",
        "/api/analyze",
        { query: "订单数量", sessionId },
        { subjectId: "session-user" },
      ),
    );
    assert.equal(first.meta.cacheHit, undefined);
    assert.equal(second.meta.cacheHit, undefined);
    const history = jsonBody(
      await request(
        baseUrl,
        "GET",
        "/api/history?limit=10",
        undefined,
        { subjectId: "session-user" },
      ),
    );
    assert.ok(history.items.some((item: any) => item.sessionId === sessionId));
  });

  await check("SSE emits a terminal answer and done event", async () => {
    const result = await request(baseUrl, "POST", "/api/analyze/stream", {
      query: "GMV",
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(String(result.body), /event: answer/);
    assert.match(String(result.body), /event: done/);
    assert.match(String(result.body), /"ok":true/);
  });

  await check("SQL-injection-shaped metric text stays read-only", async () => {
    const body = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", {
        query: "GMV; DROP TABLE users; --",
      }),
    );
    assert.equal(body.meta.queryPath, "metric");
    const followUp = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", { query: "各城市用户数" }),
    );
    assert.equal(followUp.meta.queryPath, "metric");
  });

  await check("malformed JSON is a client validation error", async () => {
    const result = await request(
      baseUrl,
      "POST",
      "/api/analyze",
      undefined,
      { rawBody: "{not-json" },
    );
    assert.equal(result.status, 400);
    assert.equal(jsonBody(result).code, "validation_error");
  });

  await check("invalid request fields fail closed", async () => {
    const missing = await request(baseUrl, "POST", "/api/analyze", {});
    assert.equal(missing.status, 400);
    assert.equal(jsonBody(missing).code, "validation_error");

    const forged = await request(baseUrl, "POST", "/api/analyze", {
      query: "GMV",
      tenantId: "attacker-tenant",
    });
    assert.equal(forged.status, 401);
    assert.equal(jsonBody(forged).code, "forged_identity");

    const choice = await request(baseUrl, "POST", "/api/analyze", {
      query: "GMV",
      clarificationChoice: "not-a-choice",
    });
    assert.equal(choice.status, 401);
    assert.equal(jsonBody(choice).code, "unauthenticated");
  });

  await check("long query is rejected before model execution", async () => {
    const result = await request(baseUrl, "POST", "/api/analyze", {
      query: "x".repeat(30_000),
    });
    assert.equal(result.status, 429);
    assert.equal(jsonBody(result).code, "budget_exceeded");
  });

  await check("history pagination clamps negative values", async () => {
    const result = await request(
      baseUrl,
      "GET",
      "/api/history?limit=-100&offset=-5",
    );
    assert.equal(result.status, 200);
    assert.equal(jsonBody(result).offset, 0);
  });

  await check("role-gated metrics and audit endpoints", async () => {
    const deniedMetrics = await request(baseUrl, "GET", "/api/metrics");
    assert.equal(deniedMetrics.status, 403);
    const allowedMetrics = await request(
      baseUrl,
      "GET",
      "/api/metrics",
      undefined,
      { roles: ["analyst", "BI_QUERY_DEBUG"] },
    );
    assert.equal(allowedMetrics.status, 200);

    const deniedAudit = await request(baseUrl, "GET", "/api/audit");
    assert.equal(deniedAudit.status, 403);
    const allowedAudit = await request(
      baseUrl,
      "GET",
      "/api/audit?limit=10",
      undefined,
      { roles: ["analyst", "BI_AUDIT_READER"] },
    );
    assert.equal(allowedAudit.status, 200);
    assert.ok(Array.isArray(jsonBody(allowedAudit).items));
  });

  let exportJobId = "";
  await check("export lifecycle enforces one-time download", async () => {
    const created = await request(baseUrl, "POST", "/api/export", {
      requestId: gmvRequestId,
    });
    assert.equal(created.status, 202);
    const job = jsonBody(created);
    exportJobId = job.jobId;
    assert.equal(job.status, "completed");
    const csv = await request(
      baseUrl,
      "GET",
      `/api/export/${exportJobId}?format=csv`,
    );
    assert.equal(csv.status, 200);
    assert.match(String(csv.body), /watermark tenant=tenant-1/);
    const second = await request(
      baseUrl,
      "GET",
      `/api/export/${exportJobId}?format=csv`,
    );
    assert.equal(second.status, 410);
  });

  await check("export requires approval and rejects unauthorized download", async () => {
    const query = assertAnalyzeOk(
      await request(baseUrl, "POST", "/api/analyze", { query: "订单数量" }),
    );
    const created = await request(baseUrl, "POST", "/api/export", {
      requestId: query.meta.requestId,
      requireApproval: true,
    });
    assert.equal(created.status, 202);
    const job = jsonBody(created);
    assert.equal(job.status, "pending_approval");
    const denied = await request(
      baseUrl,
      "POST",
      `/api/export/${job.jobId}/approve`,
      {},
      { roles: ["analyst"] },
    );
    assert.equal(denied.status, 403);
    const approved = await request(
      baseUrl,
      "POST",
      `/api/export/${job.jobId}/approve`,
      {},
      { roles: ["BI_EXPORT_APPROVER"] },
    );
    assert.equal(approved.status, 200);
    const csv = await request(
      baseUrl,
      "GET",
      `/api/export/${job.jobId}?format=csv`,
    );
    assert.equal(csv.status, 200);
  });

  await check("concurrent metric requests remain isolated", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request(
          baseUrl,
          "POST",
          "/api/analyze",
          { query: index % 2 ? "订单数量" : "各城市用户数", sessionId: `c-${index}` },
          { subjectId: `concurrent-${index}` },
        ),
      ),
    );
    assert.ok(results.every((result) => result.status === 200));
    assert.ok(
      results.every((result) => jsonBody(result).meta?.requestId),
    );
  });

  await check("tenant rate limit returns 429 under burst", async () => {
    const results = await Promise.all(
      Array.from({ length: 125 }, () =>
        request(
          baseUrl,
          "POST",
          "/api/analyze",
          { query: "GMV" },
          { tenantId: "burst-tenant", subjectId: "burst-user" },
        ),
      ),
    );
    const rateLimited = results.filter((result) => result.status === 429);
    assert.ok(rateLimited.length >= 1, `expected at least one 429, got ${rateLimited.length}`);
    assert.ok(
      rateLimited.every((result) => jsonBody(result).code === "rate_limited"),
    );
  });
} finally {
  await app.close();
}

console.log(`\nAPI matrix: ${passed.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
