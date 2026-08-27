/**
 * Black-box scenarios for the local Docker-backed development API.
 *
 * Unlike api-matrix.ts, this script never bootstraps an in-process test
 * profile. It exercises the running service at BI_LOCAL_BASE_URL (default
 * http://127.0.0.1:3000) and therefore covers live source routing as well as
 * malformed, hostile, empty, concurrent, and rate-limited requests.
 */
import assert from "node:assert/strict";

const baseUrl = (
  process.env.BI_LOCAL_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");

type HttpResult = {
  status: number;
  headers: Headers;
  body: unknown;
};

type RequestOptions = {
  subjectId?: string;
  tenantId?: string;
  roles?: string[];
  includeIdentity?: boolean;
  rawBody?: string;
  timeoutMs?: number;
};

const defaultOptions: RequestOptions = {
  subjectId: "live-matrix-user",
  tenantId: "live-matrix-tenant",
  roles: ["analyst", "BI_QUERY_DEBUG"],
};

const passed: string[] = [];
const failures: string[] = [];

function requestHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.includeIdentity !== false) {
    headers["x-subject-id"] = options.subjectId ?? defaultOptions.subjectId!;
    headers["x-tenant-id"] = options.tenantId ?? defaultOptions.tenantId!;
    if (options.roles) headers["x-roles"] = options.roles.join(",");
  }
  return headers;
}

async function request(
  method: string,
  route: string,
  body?: unknown,
  options: RequestOptions = defaultOptions,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );
  try {
    const init: RequestInit = {
      method,
      headers: requestHeaders(options),
      signal: controller.signal,
    };
    if (options.rawBody !== undefined) init.body = options.rawBody;
    else if (body !== undefined) init.body = JSON.stringify(body);

    const response = await fetch(`${baseUrl}${route}`, init);
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = text;
    if (contentType.includes("json") && text.length > 0) {
      parsed = JSON.parse(text);
    }
    return { status: response.status, headers: response.headers, body: parsed };
  } finally {
    clearTimeout(timer);
  }
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

function jsonBody(result: HttpResult): Record<string, any> {
  assert.equal(typeof result.body, "object");
  assert.ok(result.body !== null);
  return result.body as Record<string, any>;
}

function analyzeBody(result: HttpResult): Record<string, any> {
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.equal(body.needsClarification, false);
  assert.equal(typeof body.finalAnswer, "string");
  assert.ok(body.finalAnswer.length > 0);
  assert.ok(body.meta?.requestId);
  assert.ok(body.meta?.traceId);
  return body;
}

function analyzeOptions(
  source: string,
  overrides: Partial<RequestOptions> = {},
): RequestOptions {
  return {
    ...defaultOptions,
    ...overrides,
  };
}

async function analyze(
  query: string,
  source?: string,
  overrides: Partial<RequestOptions> = {},
): Promise<HttpResult> {
  return request(
    "POST",
    "/api/analyze",
    {
      query,
      ...(source ? { clarificationChoice: `datasource.${source}` } : {}),
      ...(overrides.subjectId?.startsWith("session-")
        ? { sessionId: overrides.subjectId }
        : {}),
    },
    analyzeOptions(source ?? "", overrides),
  );
}

await check("health lists all Docker live sources", async () => {
  const result = await request("GET", "/health");
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.equal(body.environment, "development");
  assert.deepEqual(
    new Set(body.liveDataSourceIds),
    new Set(["sales_mysql", "sales_mariadb", "analytics_pg"]),
  );
});

let mysqlRequestId = "";

await check("natural language entity + quarter + sales amount", async () => {
  const body = analyzeBody(
    await analyze("帮我查一下张三本季度的销售额", "sales_mysql"),
  );
  mysqlRequestId = body.meta.requestId;
  assert.equal(body.meta.queryPath, "metric");
  assert.equal(body.debugMeta?.dataSourceId, "sales_mysql");
  assert.match(body.debugMeta?.generatedSql ?? "", /created_at/i);
  assert.match(body.debugMeta?.generatedSql ?? "", />=|BETWEEN/i);
});

await check("canonical marketing phrase keeps the certified metric path", async () => {
  const body = analyzeBody(
    await analyze(
      "\u5e2e\u6211\u67e5\u4e00\u4e0b\u5f20\u4e09\u672c\u5b63\u5ea6\u7684\u8425\u9500\u989d",
      "sales_mysql",
    ),
  );
  assert.equal(body.meta.queryPath, "metric");
  assert.equal(body.debugMeta?.dataSourceId, "sales_mysql");
  const sql = body.debugMeta?.generatedSql ?? "";
  assert.match(sql, /SUM/i);
  assert.match(sql, /users[\s\S]*name/i);
  assert.match(sql, /created_at/i);
  assert.match(sql, />=|BETWEEN/i);
});

await check("营销额 synonym resolves to the certified sales metric", async () => {
  const body = analyzeBody(
    await analyze("给我查一下张三本季度的营销额", "sales_mysql"),
  );
  assert.equal(body.meta.queryPath, "metric");
  assert.equal(body.debugMeta?.dataSourceId, "sales_mysql");
});

await check("quarter trend groups and renders a line chart", async () => {
  const body = analyzeBody(
    await analyze("按季度统计各城市销售额趋势", "sales_mysql"),
  );
  assert.equal(body.chartSpec?.type, "line");
  assert.match(body.debugMeta?.generatedSql ?? "", /QUARTER|Q[1-4]/i);
  const series = body.chartSpec?.option?.series;
  assert.ok(Array.isArray(series) && series.length >= 1);
  assert.ok((series[0]?.data?.length ?? 0) >= 1);
});

if (process.env.RUN_LIVE_LLM === "1") {
  await check("live LLM RAG preserves city and multi-metric semantics", async () => {
    const body = analyzeBody(
      await analyze("统计每个城市的用户数量和订单总金额", "sales_mysql", {
        tenantId: `live-rag-${Date.now()}`,
        subjectId: "live-rag-user",
      }),
    );
    assert.equal(body.meta.queryPath, "rag");
    const sql = body.debugMeta?.generatedSql ?? "";
    assert.match(sql, /GROUP BY[\s\S]*city/i);
    assert.match(sql, /COUNT\s*\(\s*DISTINCT[\s\S]*users?[\s.]*id/i);
    assert.match(sql, /SUM\s*\([\s\S]*amount/i);
    assert.doesNotMatch(sql, /GROUP BY\s+[`\w.]*users?[`\w.]*\.?[`\w]*id/i);
  });
}

for (const source of ["sales_mysql", "sales_mariadb", "analytics_pg"]) {
  await check(`GMV routes to ${source}`, async () => {
    const body = analyzeBody(await analyze("GMV", source));
    assert.equal(body.meta.queryPath, "metric");
    assert.equal(body.debugMeta?.dataSourceId, source);
    assert.match(body.debugMeta?.generatedSql ?? "", /SUM/i);
    if (source === "sales_mysql") mysqlRequestId = body.meta.requestId;
  });
}

await check("empty dimension result is a successful empty analysis", async () => {
  const body = analyzeBody(
    await analyze("查询火星城市的GMV", "sales_mysql"),
  );
  assert.deepEqual(body.chartSpec?.dataset?.rows, []);
  assert.doesNotMatch(body.finalAnswer, /Execution error|执行失败/i);
});

await check("conflicting source request returns clarification instead of guessing", async () => {
  const result = await analyze("跨库比较 GMV");
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.equal(body.needsClarification, true);
  assert.ok(body.clarification);
});

await check("development fallback identity remains explicit", async () => {
  const result = await request("POST", "/api/analyze", { query: "GMV" }, {
    includeIdentity: false,
  });
  assert.equal(result.status, 200);
  assert.equal(jsonBody(result).needsClarification, false);
});

await check("forged identity fields are rejected", async () => {
  const result = await request(
    "POST",
    "/api/analyze",
    { query: "GMV", tenantId: "attacker-tenant", userId: "attacker" },
  );
  assert.equal(result.status, 401);
  assert.equal(jsonBody(result).code, "forged_identity");
});

await check("malformed JSON is rejected before analysis", async () => {
  const result = await request(
    "POST",
    "/api/analyze",
    undefined,
    { ...defaultOptions, rawBody: "{not-json" },
  );
  assert.equal(result.status, 400);
  assert.equal(jsonBody(result).code, "validation_error");
});

await check("empty and non-string queries fail validation", async () => {
  const empty = await request("POST", "/api/analyze", { query: "" });
  const nonString = await request("POST", "/api/analyze", { query: 42 });
  assert.equal(empty.status, 400);
  assert.equal(nonString.status, 400);
});

await check("long query is rejected before model execution", async () => {
  const result = await request("POST", "/api/analyze", {
    query: "x".repeat(30_000),
  });
  assert.equal(result.status, 429);
  assert.equal(jsonBody(result).code, "budget_exceeded");
});

await check("injection-shaped metric text remains read-only", async () => {
  const body = analyzeBody(
    await analyze("GMV; DROP TABLE orders; --", "sales_mysql"),
  );
  assert.doesNotMatch(body.debugMeta?.generatedSql ?? "", /DROP|DELETE|UPDATE/i);
});

await check("history pagination clamps negative and huge values", async () => {
  const result = await request("GET", "/api/history?limit=999999&offset=-50");
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.equal(body.offset, 0);
  assert.ok(body.items.length <= 100);
});

await check("SSE returns terminal answer and done events", async () => {
  const result = await request(
    "POST",
    "/api/analyze/stream",
    { query: "GMV", clarificationChoice: "datasource.sales_mysql" },
  );
  assert.match(result.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(typeof result.body, "string");
  assert.match(result.body as string, /event: answer/);
  assert.match(result.body as string, /event: done/);
});

await check("concurrent source requests stay isolated", async () => {
  const sources = ["sales_mysql", "sales_mariadb", "analytics_pg"];
  const results = await Promise.all(
    sources.map((source, index) =>
      analyze("GMV", source, {
        subjectId: `session-concurrent-${index}`,
        tenantId: `live-matrix-concurrent-${index}`,
      }),
    ),
  );
  results.forEach((result, index) => {
    const body = analyzeBody(result);
    assert.equal(body.debugMeta?.dataSourceId, sources[index]);
  });
});

await check("disposable tenant is rate-limited under burst", async () => {
  const tenantId = `live-matrix-rate-${Date.now()}`;
  const results = await Promise.all(
    Array.from({ length: 123 }, (_, index) =>
      analyze("GMV", "not-a-real-source", {
        tenantId,
        subjectId: `rate-user-${index}`,
      }),
    ),
  );
  const limited = results.filter((result) => result.status === 429);
  assert.ok(limited.length >= 1, `expected 429, got ${limited.length}`);
  assert.ok(
    limited.every((result) => jsonBody(result).code === "rate_limited"),
  );
});

await check("export is one-time and tied to a completed request", async () => {
  const cached = analyzeBody(await analyze("GMV", "sales_mysql"));
  assert.equal(cached.meta.cacheHit, true);
  mysqlRequestId = cached.meta.requestId;
  const created = await request("POST", "/api/export", {
    requestId: mysqlRequestId,
  });
  assert.equal(created.status, 202);
  const job = jsonBody(created);
  const first = await request("GET", `/api/export/${job.jobId}?format=csv`);
  const second = await request("GET", `/api/export/${job.jobId}?format=csv`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 410);
});

console.log(`\nLive API matrix: ${passed.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
