/**
 * HTTP 路由层（node:http 原生实现，零框架依赖）：
 * - GET  /health    探活
 * - POST /login     账号密码换 token（人）
 * - POST /api/chat  对话（人带登录 token / 系统带配发 token，走 AccessGateway）
 *
 * 该层只做协议翻译，不含任何业务判断；租户身份一律来自凭证（gateway 保证）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccessGateway, StreamEvent, Ticket } from "@agent-platform/rag-boot";
import { AuthService } from "./auth.js";
import { coreEventsToUiMessageStream, UI_MESSAGE_STREAM_HEADERS } from "./chat-stream.js";
import type { ServerConfig } from "./config.js";
import { streamPacingOf } from "./stream-pacing.js";

export type RagBotGraph = {
  streamTokens(
    input: import("@agent-platform/rag-boot").RagBotInput,
    config?: unknown,
    options?: { mode?: import("@agent-platform/rag-boot").StreamReviewMode },
  ): AsyncGenerator<StreamEvent>;
  invoke(input: import("@agent-platform/rag-boot").RagBotInput): Promise<{ answer: string; sources: string[] }>;
};

export interface HttpDeps {
  config: ServerConfig;
  authService: AuthService;
  gateway: AccessGateway;
  graph: RagBotGraph;
  /** 与图内共享同一实例（escalate/create_ticket 建单），供 GET /api/tickets 查询与评价回流 */
  ticketService: {
    list(opts?: { tenantId?: string; threadId?: string }): Promise<Ticket[]>;
    get(id: string): Promise<Ticket | undefined>;
    rate(input: { ticketId: string; rating: number; comment?: string }): Promise<Ticket>;
  };
}

const BODY_LIMIT = 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          reject(new Error("请求体必须是 JSON 对象"));
        }
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function applyCors(res: ServerResponse, config: ServerConfig, req?: IncomingMessage): void {
  const origin = req?.headers.origin;
  if (!origin) return;
  if (config.corsOrigin.includes("*") || config.corsOrigin.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-max-age", "86400");
}

/** 从 UIMessage[] 提取最后一条 user 消息的纯文本 */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; parts?: unknown } | null;
    if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
    const text = message.parts
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    if (text.trim()) return text.trim();
  }
  return "";
}

/** 工单对客户端的可见字段：handoff（含完整会话转写）/ history / 幂等键等内部字段不外露 */
export function toTicketDto(ticket: Ticket) {
  return {
    id: ticket.id,
    threadId: ticket.threadId,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    resolution: ticket.resolution ?? null,
    humanInvolved: ticket.humanInvolved,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt ?? null,
    rating: ticket.rating ?? null,
  };
}

/**
 * GET /api/tickets：当前登录租户的工单列表。
 * 可选 ?threadId= 过滤单个会话。租户身份只来自 token；不接手 AccessGateway 的
 * 幂等/限流（只读查询、无入口写副作用），但仍要求有效凭证。
 */
async function handleTicketList(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const token = AuthService.tokenFromAuthorizationHeader(req.headers.authorization);
  const identity = token ? deps.authService.authenticate({ token }) : null;
  if (!identity) {
    sendJson(res, 401, { error: "未认证或凭证已失效，请重新登录" });
    return;
  }

  const threadIdRaw = url.searchParams.get("threadId")?.trim();
  const tickets = await deps.ticketService.list({
    tenantId: identity.tenantId,
    ...(threadIdRaw ? { threadId: threadIdRaw } : {}),
  });
  const sorted = [...tickets].sort((a, b) => b.createdAt - a.createdAt);
  sendJson(res, 200, { tickets: sorted.map(toTicketDto) });
}

/**
 * GET /api/tickets/:id：单张工单详情（同租户才可见，否则 404 不泄露存在性）。
 */
async function handleTicketDetail(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  ticketId: string,
): Promise<void> {
  const token = AuthService.tokenFromAuthorizationHeader(req.headers.authorization);
  const identity = token ? deps.authService.authenticate({ token }) : null;
  if (!identity) {
    sendJson(res, 401, { error: "未认证或凭证已失效，请重新登录" });
    return;
  }

  const ticket = await deps.ticketService.get(ticketId);
  if (!ticket || ticket.tenantId !== identity.tenantId) {
    sendJson(res, 404, { error: "工单不存在" });
    return;
  }
  sendJson(res, 200, { ticket: toTicketDto(ticket) });
}

/**
 * POST /api/tickets/:id/rating：评价回流（T5.4/T7.2 满意度数据来源）。
 * 评价人必须与工单同租户；rating 1-5，comment 可选（≤500 字）。
 */
async function handleTicketRating(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  ticketId: string,
): Promise<void> {
  const token = AuthService.tokenFromAuthorizationHeader(req.headers.authorization);
  const identity = token ? deps.authService.authenticate({ token }) : null;
  if (!identity) {
    sendJson(res, 401, { error: "未认证或凭证已失效，请重新登录" });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    sendJson(res, 400, { error: "rating 必须是 1-5 的整数" });
    return;
  }
  const commentRaw = typeof body.comment === "string" ? body.comment.trim() : "";
  const comment = commentRaw ? commentRaw.slice(0, 500) : undefined;

  const ticket = await deps.ticketService.get(ticketId);
  if (!ticket || ticket.tenantId !== identity.tenantId) {
    sendJson(res, 404, { error: "工单不存在" });
    return;
  }

  try {
    const updated = await deps.ticketService.rate({ ticketId, rating, ...(comment ? { comment } : {}) });
    sendJson(res, 200, { ticket: toTicketDto(updated) });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChat(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { gateway, graph, config } = deps;
  const token = AuthService.tokenFromAuthorizationHeader(req.headers.authorization);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const query = lastUserText(body.messages) || String(body.query ?? "").trim();
  if (!query) {
    sendJson(res, 400, { error: "缺少用户消息（messages 或 query）" });
    return;
  }

  const messageId = typeof body.messageId === "string" && body.messageId.trim()
    ? body.messageId.trim()
    : crypto.randomUUID();
  const threadId = typeof body.threadId === "string" && body.threadId.trim()
    ? body.threadId.trim()
    : messageId;

  // 鉴权 → 幂等 → 限流（AccessGateway 固定顺序；租户身份只来自凭证）
  const admitted = gateway.admit({
    credential: { token: token ?? "" },
    messageId,
    threadId,
    body: {
      query,
      confirmationProposalId: body.confirmationProposalId,
      confirmationToken: body.confirmationToken,
      transcriptConfidence: body.transcriptConfidence,
    },
  });
  if (!admitted.ok) {
    if (admitted.code === "rate_limited") {
      const retryAfterSeconds = Math.ceil((admitted.retryAfterMs ?? 60_000) / 1000);
      res.setHeader("retry-after", String(retryAfterSeconds));
      sendJson(res, 429, {
        error: "请求过于频繁，请稍后再试",
        retryAfterMs: admitted.retryAfterMs ?? 60_000,
      });
      return;
    }
    sendJson(res, admitted.code === "unauthenticated" ? 401 : 409, { error: admitted.reason, code: admitted.code });
    return;
  }

  if (admitted.processing) {
    res.setHeader("retry-after", "2");
    sendJson(res, 409, { code: "processing", error: "消息仍在处理中，请使用相同 messageId 重试。" });
    return;
  }

  const input = gateway.toGraphInput(admitted);

  if (config.corsOrigin.length > 0) applyCors(res, config, req);
  res.writeHead(200, UI_MESSAGE_STREAM_HEADERS);

  // 客户端断开时停止继续吐块（否则会对着已关闭的连接白写一路）
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  // 完成的重试由核心重放缓存结果；先审后发，断开不会取消尚未落盘的执行。
  // configurable.thread_id 让 checkpointer 按 threadId 持久化会话状态——
  // 多轮指代消解（rewrite 的 history）与跨轮记忆都依赖它；缺失 = 每轮从零开始。
  const events = graph.streamTokens(
    input,
    { configurable: { thread_id: threadId } },
    { mode: config.reviewStreamMode },
  );
  const stream = coreEventsToUiMessageStream(events, {
    ...streamPacingOf(config),
    isCancelled: () => clientGone,
  });
  await stream.pipeTo(
    new WritableStream({
      write(chunk) {
        if (!clientGone) res.write(chunk);
      },
    }),
    { preventCancel: false },
  );
  res.end();
}

export async function handleRequest(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method ?? "GET"} ${url.pathname}`;

  applyCors(res, deps.config, req);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (route === "GET /health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === "POST /login") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const username = String(body.username ?? "");
      const password = String(body.password ?? "");
      const issued = deps.authService.login(username, password);
      if (!issued) {
        sendJson(res, 401, { error: "用户名或密码错误" });
        return;
      }
      sendJson(res, 200, {
        token: issued.token,
        username: issued.username,
        tenantId: issued.tenantId,
        expiresAt: issued.expiresAt,
      });
      return;
    }

    if (route === "POST /api/chat") {
      await handleChat(deps, req, res);
      return;
    }

    if (route === "GET /api/tickets") {
      await handleTicketList(deps, req, res, url);
      return;
    }

    const ticketDetailMatch = route.match(/^GET \/api\/tickets\/([A-Za-z0-9-]+)$/);
    if (ticketDetailMatch) {
      await handleTicketDetail(deps, req, res, ticketDetailMatch[1]);
      return;
    }

    const ticketRatingMatch = route.match(/^POST \/api\/tickets\/([A-Za-z0-9-]+)\/rating$/);
    if (ticketRatingMatch) {
      await handleTicketRating(deps, req, res, ticketRatingMatch[1]);
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (error) {
    console.error("[http] 未处理异常:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "服务内部错误" });
    } else {
      res.end();
    }
  }
}
