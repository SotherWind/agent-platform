/**
 * 二期能力的 HTTP/流协议测试：
 * - chat-stream：final 事件的 citations/confirmation/ticket → data-* 自定义 part
 * - http：确认流字段透传进图、GET /api/tickets 租户隔离与 DTO 清洗
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamEvent } from "@agent-platform/rag-boot";
import { AuthService } from "../src/auth.js";
import { coreEventsToUiMessageStream, sseFrame, UI_MESSAGE_STREAM_HEADERS } from "../src/chat-stream.js";
import type { ServerConfig } from "../src/config.js";
import { buildAccessGateway } from "../src/gateway.js";
import { handleRequest, toTicketDto, type HttpDeps, type RagBotGraph } from "../src/http.js";
import { InMemoryTicketStore, TicketService } from "@agent-platform/rag-boot";

// ---------------------------------------------------------------------------
// chat-stream：结构化元数据 → data part
// ---------------------------------------------------------------------------

async function collect(events: StreamEvent[]): Promise<string> {
  async function* gen() {
    for (const event of events) yield event;
  }
  const stream = coreEventsToUiMessageStream(gen(), { chunkSize: 100, delayMs: 0 });
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFrames(raw: string): Array<Record<string, any>> {
  return raw
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("coreEventsToUiMessageStream 二期 data part", () => {
  it("final 附带 citations/confirmation/ticket → 依序发出 data-citations / data-ticket / data-confirm", async () => {
    const raw = await collect([
      { type: "delta", text: "我可以帮你执行：提议退款" },
      {
        type: "final",
        answer: "我可以帮你执行：提议退款",
        sources: [],
        citations: [{ chunkId: "c-1", documentId: "d-1", text: "退款规则原文" }],
        confirmation: {
          proposalId: "prop-1",
          action: "propose_refund",
          summary: "提议退款",
          params: { orderId: "o-1", amountCents: 9900 },
          confirmToken: "tok-1",
          expiresAt: 123456,
        },
        ticket: { ticketId: "tk-1" },
      },
    ]);
    const frames = parseFrames(raw);
    const types = frames.map((f) => f.type);

    expect(types).toContain("data-citations");
    expect(types).toContain("data-ticket");
    expect(types).toContain("data-confirm");

    // 顺序：citations → ticket → confirm，且都在 finish 之前
    expect(types.indexOf("data-citations")).toBeLessThan(types.indexOf("data-ticket"));
    expect(types.indexOf("data-ticket")).toBeLessThan(types.indexOf("data-confirm"));
    expect(types.indexOf("data-confirm")).toBeLessThan(types.indexOf("finish"));

    const citations = frames.find((f) => f.type === "data-citations");
    expect(citations?.data.citations).toEqual([{ chunkId: "c-1", documentId: "d-1", text: "退款规则原文" }]);
    const confirm = frames.find((f) => f.type === "data-confirm");
    expect(confirm?.data).toMatchObject({ proposalId: "prop-1", confirmToken: "tok-1" });
  });

  it("普通回答（无结构化元数据）→ 不发任何二期 data part", async () => {
    const raw = await collect([{ type: "final", answer: "你好", sources: [] }]);
    const types = parseFrames(raw).map((f) => f.type);
    expect(types).toEqual(["start", "text-start", "text-end", "finish"]);
  });

  it("sseFrame 产出标准 SSE 帧", () => {
    expect(sseFrame({ type: "start" })).toBe('data: {"type":"start"}\n\n');
  });
});

// ---------------------------------------------------------------------------
// http：确认透传 + 工单列表
// ---------------------------------------------------------------------------

const baseConfig: ServerConfig = {
  environment: "development",
  port: 0,
  corsOrigin: [],
  users: [
    { username: "alice", password: "alice123", tenantId: "tenant-a" },
    { username: "bob", password: "bob123", tenantId: "tenant-b" },
  ],
  systemTokens: [],
  tokenTtlSeconds: 60,
  autoIngest: false,
  knowledgeDir: "./knowledge",
  useFakeLlm: false,
  streamChunkSize: 100,
  streamChunkDelayMs: 0,
  reviewStreamMode: "chunked",
  specialistPolicy: "always",
  proposalSecret: "test-secret",
};

describe("http 二期路由", () => {
  let server: Server;
  let baseUrl: string;
  let capturedInput: Record<string, unknown> | null = null;
  let aliceToken: string;
  let bobToken: string;

  const ticketService = new TicketService({ store: new InMemoryTicketStore() });

  const fakeGraph: RagBotGraph = {
    async *streamTokens(input) {
      capturedInput = { ...input } as Record<string, unknown>;
      yield { type: "delta", text: "回复" };
      yield {
        type: "final",
        answer: "回复",
        sources: [],
        confirmation: {
          proposalId: "prop-9",
          action: "propose_refund",
          summary: "提议退款",
          params: {},
          confirmToken: "tok-9",
          expiresAt: 999,
        },
      };
    },
    async invoke() {
      return { answer: "", sources: [] };
    },
  };

  beforeAll(async () => {
    const auth = new AuthService(baseConfig);
    aliceToken = auth.login("alice", "alice123")!.token;
    bobToken = auth.login("bob", "bob123")!.token;

    await ticketService.create({
      tenantId: "tenant-a",
      threadId: "th-a1",
      category: "order",
      subject: "退款进度",
      humanInvolved: true,
      handoff: { transcript: ["内部转写，不应外露"] },
      idempotencyKey: "k-a1",
    });
    await ticketService.create({
      tenantId: "tenant-a",
      threadId: "th-a2",
      category: "billing",
      subject: "发票问题",
      humanInvolved: true,
      idempotencyKey: "k-a2",
    });
    await ticketService.create({
      tenantId: "tenant-b",
      threadId: "th-b1",
      category: "account",
      subject: "换绑手机",
      humanInvolved: true,
      idempotencyKey: "k-b1",
    });

    const deps: HttpDeps = { config: baseConfig, authService: auth, gateway: buildAccessGateway(auth), graph: fakeGraph, ticketService };
    server = createServer((req, res) => {
      void handleRequest(deps, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POST /api/chat 把 confirmationProposalId/confirmationToken 透传进图，流里带 data-confirm", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "请退款" }] }],
        threadId: "th-confirm",
        messageId: "msg-confirm-1",
        confirmationProposalId: "prop-42",
        confirmationToken: "tok-42",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    expect(capturedInput).toMatchObject({
      query: "请退款",
      threadId: "th-confirm",
      confirmationProposalId: "prop-42",
      confirmationToken: "tok-42",
    });

    const raw = await response.text();
    const confirm = parseFrames(raw).find((f) => f.type === "data-confirm");
    expect(confirm?.data).toMatchObject({ proposalId: "prop-9", confirmToken: "tok-9" });
  });

  it("GET /api/tickets 未认证 → 401", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`);
    expect(response.status).toBe(401);
  });

  it("GET /api/tickets 只返回本租户工单（新单在前），不外露 handoff/history", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { tickets: Array<Record<string, unknown>> };
    expect(payload.tickets).toHaveLength(2);
    expect(payload.tickets.every((t) => !("handoff" in t) && !("history" in t) && !("idempotencyKey" in t))).toBe(true);
    // 新单在前
    expect(payload.tickets[0].subject).toBe("发票问题");
    expect(payload.tickets[1].subject).toBe("退款进度");
  });

  it("GET /api/tickets?threadId= 过滤指定会话", async () => {
    const response = await fetch(`${baseUrl}/api/tickets?threadId=th-a1`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const payload = (await response.json()) as { tickets: Array<Record<string, unknown>> };
    expect(payload.tickets).toHaveLength(1);
    expect(payload.tickets[0].threadId).toBe("th-a1");
  });

  it("GET /api/tickets 租户隔离：bob 看不到 alice 的工单", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    const payload = (await response.json()) as { tickets: Array<{ subject: string }> };
    expect(payload.tickets.map((t) => t.subject)).toEqual(["换绑手机"]);
  });
});

// ---------------------------------------------------------------------------
// http 三期：工单详情 + 评价回流
// ---------------------------------------------------------------------------

describe("http 三期路由（工单详情/评价）", () => {
  let server: Server;
  let baseUrl: string;
  let aliceToken: string;
  let bobToken: string;
  let aliceTicketId: string;

  const ticketService = new TicketService({ store: new InMemoryTicketStore() });

  const fakeGraph: RagBotGraph = {
    async *streamTokens(input) {
      yield { type: "delta", text: "回复" };
      yield { type: "final", answer: "回复", sources: [] };
    },
    async invoke() {
      return { answer: "", sources: [] };
    },
  };

  beforeAll(async () => {
    const auth = new AuthService(baseConfig);
    aliceToken = auth.login("alice", "alice123")!.token;
    bobToken = auth.login("bob", "bob123")!.token;

    const created = await ticketService.create({
      tenantId: "tenant-a",
      threadId: "th-detail",
      category: "order",
      subject: "退款进度查询",
      humanInvolved: true,
      handoff: { transcript: ["内部转写"] },
      idempotencyKey: "k-detail",
    });
    aliceTicketId = created.id;

    const deps: HttpDeps = { config: baseConfig, authService: auth, gateway: buildAccessGateway(auth), graph: fakeGraph, ticketService };
    server = createServer((req, res) => {
      void handleRequest(deps, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /api/tickets/:id 同租户可见（DTO 清洗）", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/${aliceTicketId}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ticket: Record<string, unknown> };
    expect(payload.ticket.id).toBe(aliceTicketId);
    expect(payload.ticket.subject).toBe("退款进度查询");
    expect(Object.keys(payload.ticket)).not.toContain("handoff");
  });

  it("GET /api/tickets/:id 跨租户 → 404（不泄露存在性）", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/${aliceTicketId}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(response.status).toBe(404);
  });

  it("GET /api/tickets/:id 未认证 → 401；不存在 → 404", async () => {
    const unauthorized = await fetch(`${baseUrl}/api/tickets/${aliceTicketId}`);
    expect(unauthorized.status).toBe(401);

    const missing = await fetch(`${baseUrl}/api/tickets/tk-not-exist`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(missing.status).toBe(404);
  });

  it("POST /api/tickets/:id/rating 同租户评价成功并回流 DTO", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/${aliceTicketId}/rating`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ rating: 5, comment: "处理很快" }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ticket: { rating: number; ratingComment?: string | null } };
    expect(payload.ticket.rating).toBe(5);
  });

  it("POST /api/tickets/:id/rating 非法 rating → 400；跨租户 → 404", async () => {
    const bad = await fetch(`${baseUrl}/api/tickets/${aliceTicketId}/rating`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ rating: 9 }),
    });
    expect(bad.status).toBe(400);

    const foreign = await fetch(`${baseUrl}/api/tickets/${aliceTicketId}/rating`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ rating: 1 }),
    });
    expect(foreign.status).toBe(404);
  });
});

describe("toTicketDto", () => {
  it("只保留客户端可见字段", () => {
    const dto = toTicketDto({
      id: "tk-1",
      tenantId: "t",
      threadId: "th",
      category: "order",
      subject: "s",
      status: "open",
      assignee: null,
      createdAt: 1,
      updatedAt: 2,
      closedAt: null,
      resolution: null,
      humanInvolved: true,
      secondVisit: false,
      rating: null,
      ratingComment: null,
      ratingCategory: null,
      history: [],
      handoff: { transcript: ["secret"] },
      idempotencyKey: "k",
    } as any);
    expect(Object.keys(dto).sort()).toEqual(
      ["category", "closedAt", "createdAt", "humanInvolved", "id", "rating", "resolution", "status", "subject", "threadId", "updatedAt"],
    );
  });
});

// 避免 UI_MESSAGE_STREAM_HEADERS 未使用告警（协议头断言隐含在上面 content-type 检查里）
void UI_MESSAGE_STREAM_HEADERS;
