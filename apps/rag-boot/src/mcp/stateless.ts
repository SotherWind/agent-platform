/**
 * T3.4 MCP 无状态适配接口。
 *
 * 该模块只锁定无握手、无粘性会话、MRTR input_required 的接口形状；
 * 具体 MCP SDK / 传输协议由接入方注入。服务端不保存连接状态，requestState
 * 由工具返回并由调用方在下一次请求中回带。
 */
import { parseTraceparent, traceparent, type Span } from "../observability/tracer";

export interface McpTraceMeta {
  traceparent?: string;
  [key: string]: unknown;
}

export interface McpToolCallRequest {
  method: "tools/call";
  name: string;
  arguments: Record<string, unknown>;
  /** MRTR 恢复状态：只由工具返回、由调用方回带。 */
  requestState?: string;
}

export interface McpInputRequest {
  id: string;
  prompt: string;
  type?: "text" | "secret" | "choice";
  options?: string[];
}

export type McpToolCallResponse =
  | {
      status: "ok";
      content: unknown;
      requestState?: string;
      meta?: McpTraceMeta;
    }
  | {
      status: "input_required";
      inputRequests: McpInputRequest[];
      requestState: string;
      meta?: McpTraceMeta;
    };

export interface McpInputResumeRequest {
  method: "tools/call";
  name: string;
  arguments: Record<string, unknown>;
  inputResponses: Record<string, string>;
  requestState: string;
}

export interface StatelessMcpTransport {
  /** 每个请求均可路由到任意服务实例，不依赖 initialize 或 session id。 */
  request(
    request: McpToolCallRequest | McpInputResumeRequest,
    meta?: McpTraceMeta,
  ): Promise<McpToolCallResponse>;
}

export function buildMcpMeta(
  spanOrTrace: Pick<Span, "traceId" | "spanId"> | string,
  extra: Record<string, unknown> = {},
): McpTraceMeta {
  const parent = typeof spanOrTrace === "string" ? parseTraceparent(spanOrTrace) : null;
  const header =
    typeof spanOrTrace === "string"
      ? spanOrTrace
      : traceparent(spanOrTrace);
  return {
    ...extra,
    traceparent: header,
    ...(parent ? { parentTraceId: parent.traceId, parentSpanId: parent.spanId } : {}),
  };
}

export class StatelessMcpAdapter {
  constructor(private readonly transport: StatelessMcpTransport) {}

  /** 首个请求可以直接是真实工具调用，无 initialize / Mcp-Session-Id。 */
  async call(input: {
    name: string;
    arguments?: Record<string, unknown>;
    requestState?: string;
    trace?: Pick<Span, "traceId" | "spanId"> | string;
  }): Promise<McpToolCallResponse> {
    return this.transport.request(
      {
        method: "tools/call",
        name: input.name,
        arguments: input.arguments ?? {},
        ...(input.requestState ? { requestState: input.requestState } : {}),
      },
      input.trace ? buildMcpMeta(input.trace) : undefined,
    );
  }

  /** 收集 MRTR inputResponses，并回带 requestState 重发。 */
  async resume(input: {
    name: string;
    arguments?: Record<string, unknown>;
    inputResponses: Record<string, string>;
    requestState: string;
    trace?: Pick<Span, "traceId" | "spanId"> | string;
  }): Promise<McpToolCallResponse> {
    return this.transport.request(
      {
        method: "tools/call",
        name: input.name,
        arguments: input.arguments ?? {},
        inputResponses: input.inputResponses,
        requestState: input.requestState,
      },
      input.trace ? buildMcpMeta(input.trace) : undefined,
    );
  }
}
