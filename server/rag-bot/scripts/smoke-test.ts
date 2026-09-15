/**
 * 后端一键冒烟测试：不依赖浏览器，直接验证 HTTP 全链路。
 *
 * 用法（server 需已在 8787 运行）：
 *   node node_modules/tsx/dist/cli.mjs scripts/smoke-test.ts
 *   node node_modules/tsx/dist/cli.mjs scripts/smoke-test.ts http://localhost:8787
 *
 * 覆盖：探活 → 登录 → 知识问答(引用) → 转人工建单 → 工单列表 → 评价 → 非法评分 → 未认证拦截。
 * 真实 LLM 模式下单轮可能耗时 10-30s（取决于模型端点）。
 */
import "../src/env.js";

const base = process.argv[2] ?? "http://localhost:8787";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: `${detail} (${((Date.now() - started) / 1000).toFixed(1)}s)` });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** 读一条 SSE 流，收集全部帧 */
async function readSse(
  response: Response,
  onFrame: (frame: Record<string, unknown>) => void,
): Promise<void> {
  if (!response.body) throw new Error("响应无 body");
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += new TextDecoder().decode(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        onFrame(JSON.parse(line.slice("data: ".length)));
      } catch {
        /* 忽略无法解析的帧 */
      }
    }
  }
}

async function chat(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert(response.status === 200, `chat HTTP ${response.status}`);
  await readSse(response, (frame) => frames.push(frame));
  return frames;
}

async function main(): Promise<void> {
  let token = "";
  let ticketId = "";

  await check("1. 探活 GET /health", async () => {
    const response = await fetch(`${base}/health`);
    assert(response.ok, `HTTP ${response.status}`);
    return "ok";
  });

  await check("2. 登录 demo/demo123", async () => {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo", password: "demo123" }),
    });
    assert(response.ok, `HTTP ${response.status}`);
    const payload = (await response.json()) as { token: string };
    assert(payload.token, "未返回 token");
    token = payload.token;
    return "获得 token";
  });

  await check("3. 未认证访问工单列表 → 401", async () => {
    const response = await fetch(`${base}/api/tickets`);
    assert(response.status === 401, `期望 401，实际 ${response.status}`);
    return "拦截生效";
  });

  await check("4. 知识问答 → 回答 + data-citations", async () => {
    const frames = await chat(token, {
      messages: [{ id: "s1", role: "user", parts: [{ type: "text", text: "退货政策是什么？" }] }],
      threadId: `smoke-${Date.now()}`,
      messageId: `smoke-${Date.now()}`,
    });
    const citations = frames.find((f) => f.type === "data-citations") as
      | { data: { citations: unknown[] } }
      | undefined;
    const finish = frames.find((f) => f.type === "finish") as { finishReason?: string } | undefined;
    assert(finish?.finishReason === "stop", `finish=${finish?.finishReason}`);
    assert(citations?.data.citations.length, "未收到引用来源");
    return `${citations!.data.citations.length} 条引用`;
  });

  await check("5. 转人工 → 兜底回答 + data-ticket 建单", async () => {
    const threadId = `smoke-ticket-${Date.now()}`;
    const frames = await chat(token, {
      messages: [{ id: "s2", role: "user", parts: [{ type: "text", text: "转人工" }] }],
      threadId,
      messageId: `smoke-ticket-${Date.now()}`,
    });
    const ticket = frames.find((f) => f.type === "data-ticket") as { data: { ticketId: string } } | undefined;
    assert(ticket?.data.ticketId, "未收到工单号");
    ticketId = ticket.data.ticketId;
    return `工单 ${ticketId.slice(0, 8)}`;
  });

  await check("6. 工单列表包含新单（DTO 无内部字段）", async () => {
    const response = await fetch(`${base}/api/tickets`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert(response.ok, `HTTP ${response.status}`);
    const payload = (await response.json()) as { tickets: Array<Record<string, unknown>> };
    const mine = payload.tickets.find((t) => t.id === ticketId);
    assert(mine, "列表中找不到刚建的工单");
    assert(!("handoff" in mine) && !("history" in mine), "DTO 泄露内部字段");
    return `共 ${payload.tickets.length} 张`;
  });

  await check("7. 评价 5 星 → 回流成功", async () => {
    const response = await fetch(`${base}/api/tickets/${ticketId}/rating`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ rating: 5, comment: "冒烟测试评价" }),
    });
    assert(response.ok, `HTTP ${response.status}`);
    const payload = (await response.json()) as { ticket: { rating: number } };
    assert(payload.ticket.rating === 5, "评分未保存");
    return "rating=5";
  });

  await check("8. 非法评分 9 → 400", async () => {
    const response = await fetch(`${base}/api/tickets/${ticketId}/rating`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ rating: 9 }),
    });
    assert(response.status === 400, `期望 400，实际 ${response.status}`);
    return "拦截生效";
  });

  console.log("\n===== 冒烟结果 =====");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}  ${r.ok ? r.detail : `→ ${r.detail}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? "，存在失败项" : "，全部通过"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("[smoke] 执行失败:", error);
  process.exit(1);
});
