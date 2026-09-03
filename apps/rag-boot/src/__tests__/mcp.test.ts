import { StatelessMcpAdapter, buildMcpMeta, type McpToolCallRequest } from "../mcp/stateless";

describe("T3.4 MCP 无状态适配", () => {
  it("首个请求直接调用工具，不发送握手或 session id", async () => {
    const requests: McpToolCallRequest[] = [];
    const adapter = new StatelessMcpAdapter({
      async request(request) {
        requests.push(request as McpToolCallRequest);
        return { status: "ok", content: { ok: true } };
      },
    });
    await expect(adapter.call({ name: "get_order_status", arguments: { orderId: "o-1" } })).resolves.toMatchObject({ status: "ok" });
    expect(requests[0]).toEqual({ method: "tools/call", name: "get_order_status", arguments: { orderId: "o-1" } });
    expect(requests[0]).not.toHaveProperty("sessionId");
  });

  it("input_required 后收集 inputResponses 并回带 requestState", async () => {
    const calls: unknown[] = [];
    const adapter = new StatelessMcpAdapter({
      async request(request) {
        calls.push(request);
        if (calls.length === 1) {
          return {
            status: "input_required",
            inputRequests: [{ id: "otp", prompt: "请输入验证码", type: "secret" }],
            requestState: "state-1",
          };
        }
        return { status: "ok", content: { verified: true }, requestState: "state-1" };
      },
    });
    const required = await adapter.call({ name: "verify", arguments: {} });
    expect(required.status).toBe("input_required");
    if (required.status !== "input_required") return;
    const resumed = await adapter.resume({
      name: "verify",
      inputResponses: { otp: "123456" },
      requestState: required.requestState,
    });
    expect(resumed).toMatchObject({ status: "ok" });
    expect(calls[1]).toEqual({
      method: "tools/call",
      name: "verify",
      arguments: {},
      inputResponses: { otp: "123456" },
      requestState: "state-1",
    });
  });

  it("_meta 透传 W3C Trace Context，服务端不持有连接状态", () => {
    const meta = buildMcpMeta({ traceId: "a".repeat(32), spanId: "b".repeat(16) });
    expect(meta.traceparent).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  });

  it("不依赖 Mcp-Session-Id，任意实例可响应（恢复请求经另一实例）", async () => {
    // T3.4#2（清单 494 行）：此前只测了「不发送 session id」，
    // 「任意实例可响应」没测——MRTR 恢复请求打到全新实例也必须成功。
    // 实例 A：首次调用返回 input_required
    const instanceA = new StatelessMcpAdapter({
      async request() {
        return {
          status: "input_required",
          inputRequests: [{ id: "otp", prompt: "请输入验证码", type: "secret" }],
          requestState: "state-shared",
        };
      },
    });
    const required = await instanceA.call({ name: "verify", arguments: {} });
    if (required.status !== "input_required") throw new Error("expected input_required");

    // 实例 B：全新 adapter（模拟负载均衡打到另一台机器）。
    // 它对实例 A 一无所知——只凭请求体里回带的 requestState 就能恢复，无需粘性会话。
    let resumeCarriedState = false;
    const instanceB = new StatelessMcpAdapter({
      async request(request) {
        resumeCarriedState = (request as { requestState?: string }).requestState === "state-shared";
        return { status: "ok", content: { verified: true } };
      },
    });
    const resumed = await instanceB.resume({
      name: "verify",
      inputResponses: { otp: "123456" },
      requestState: required.requestState,
    });
    expect(resumed.status).toBe("ok");
    expect(resumeCarriedState).toBe(true); // 状态由调用方携带，服务端不持有
  });
});
