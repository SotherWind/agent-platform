import { StatelessMcpAdapter, buildMcpMeta, type McpToolCallRequest } from "../mcp/stateless";
import { proposalToInputRequired, resumeToConfirmation } from "../mcp/confirmation";
import type { ActionProposal } from "../actions/proposal";

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

describe("T3.4 ↔ T5.3 桥接：确认状态走 MRTR", () => {
  // T3.4 实现要点（清单 500 行）「确认状态（T5.3）走 MRTR 而不是长连接反向请求」
  // 此前 StatelessMcpAdapter 只有协议形状，与 T5.3 之间没有任何桥接代码。
  const proposal: ActionProposal = {
    id: "prop-1",
    action: "refund",
    params: { orderId: "o-1" },
    summary: "确认退款 100 元？",
    tenantId: "t1",
    threadId: "th-1",
    principal: "user-1",
    confirmToken: "tok-abc",
    createdAt: 1000,
    expiresAt: 2_000_000,
    status: "pending",
    idempotencyKey: "idem-1",
  };

  it("确认请求以 input_required 返回，确认状态封装进 requestState", () => {
    const response = proposalToInputRequired(proposal);
    if (response.status !== "input_required") throw new Error("expected input_required");

    expect(response.inputRequests[0]).toMatchObject({
      id: "confirm",
      prompt: proposal.summary,
      type: "choice",
      options: ["confirm", "cancel"],
    });
    expect(response.requestState).toBeTruthy();
    expect(response.requestState).not.toBe(proposal.confirmToken); // 不透明串，不是明文令牌
  });

  it("resume 回带 requestState 可解出 T5.3 confirm 入参（往返一致）", () => {
    const response = proposalToInputRequired(proposal);
    if (response.status !== "input_required") throw new Error("expected input_required");

    const confirmation = resumeToConfirmation({
      method: "tools/call",
      name: "refund",
      arguments: { orderId: "o-1" },
      inputResponses: { confirm: "confirm" },
      requestState: response.requestState,
    });

    expect(confirmation).toEqual({
      proposalId: proposal.id,
      confirmToken: proposal.confirmToken,
      expiresAt: proposal.expiresAt,
      confirmed: true,
    });
  });

  it("用户取消时 confirmed=false，且解码过程不持有任何服务端状态", () => {
    const response = proposalToInputRequired(proposal);
    if (response.status !== "input_required") throw new Error("expected input_required");

    // encode/decode 是纯函数——状态全在 requestState 里，天然满足「任意实例可响应」
    const cancelled = resumeToConfirmation({
      method: "tools/call",
      name: "refund",
      arguments: {},
      inputResponses: { confirm: "cancel" },
      requestState: response.requestState,
    });
    expect(cancelled.confirmed).toBe(false);
  });

  it("非法 requestState 拒绝解码（fail-closed）", () => {
    expect(() =>
      resumeToConfirmation({
        method: "tools/call",
        name: "refund",
        arguments: {},
        inputResponses: { confirm: "confirm" },
        requestState: "garbage-state",
      }),
    ).toThrow();
  });
});
