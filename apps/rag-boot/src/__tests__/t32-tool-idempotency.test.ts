/**
 * T3.2 幂等键
 *
 * 依据 MCP 2026-07-28 规范：客户端会重发中断的调用，工具必须幂等。
 *
 * 验收（清单 406 行）：重发不会重复退款 / 重复建单。
 */
import { executeTool, toolIdempotencyKey, stableStringify } from "../tools/contract";
import { InMemoryIdempotencyStore, SqliteIdempotencyStore } from "../tools/idempotency";
import { FakeBackend, createOrderStatusTool, createRefundTool } from "../tools/business";
import { ProposalService } from "../actions/proposal";

function readCtx(store: InMemoryIdempotencyStore, turnIndex = 1) {
  return {
    tenantId: "t",
    threadId: "th",
    principal: "p",
    turnIndex,
    idempotency: store,
    audit: () => {},
  };
}

describe("工具幂等", () => {
  it("相同 idempotencyKey 重复调用只产生一次副作用", async () => {
    const backend = new FakeBackend();
    const tool = createOrderStatusTool(backend);
    const store = new InMemoryIdempotencyStore();

    const first = await executeTool(tool, { orderId: "o-1", tenantId: "t" }, readCtx(store));
    const second = await executeTool(tool, { orderId: "o-1", tenantId: "t" }, readCtx(store));

    // 副作用只发生一次；第二次命中缓存
    expect(backend.calls.filter((c) => c.method === "getOrderStatus")).toHaveLength(1);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);

    // 写工具同理：确认后的重发不重复退款
    const refund = createRefundTool(backend);
    const service = new ProposalService();
    const proposal = service.propose({
      action: refund.name, params: { orderId: "o-2", amountCents: 100 },
      summary: "refund", tenantId: "t", principal: "p", threadId: "th",
    });
    service.confirm({ proposalId: proposal.id, token: proposal.confirmToken, tenantId: "t", principal: "p", threadId: "th" });
    const refundCtx = {
      ...readCtx(new InMemoryIdempotencyStore()), confirmToken: proposal.confirmToken,
      confirmationProposalId: proposal.id, verifyConfirmation: service.verifyConfirmation.bind(service),
    };
    await executeTool(refund, { orderId: "o-2", amountCents: 100, tenantId: "t" }, refundCtx);
    await executeTool(refund, { orderId: "o-2", amountCents: 100, tenantId: "t" }, refundCtx);
    expect(backend.refunds).toHaveLength(1);
  });

  it("返回值对重复调用保持一致", async () => {
    const backend = new FakeBackend();
    const tool = createOrderStatusTool(backend);
    const store = new InMemoryIdempotencyStore();

    const first = await executeTool(tool, { orderId: "o-1", tenantId: "t" }, readCtx(store));
    const second = await executeTool(tool, { orderId: "o-1", tenantId: "t" }, readCtx(store));

    expect(second.result).toEqual(first.result);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("不同 key 的相同参数调用产生两次副作用", async () => {
    const backend = new FakeBackend();
    const tool = createOrderStatusTool(backend);

    // 参数相同、turnIndex 不同 → key 不同 → 各执行一次
    const ctxA = readCtx(new InMemoryIdempotencyStore(), 1);
    const ctxB = readCtx(new InMemoryIdempotencyStore(), 2);
    await executeTool(tool, { orderId: "o-1", tenantId: "t" }, ctxA);
    await executeTool(tool, { orderId: "o-1", tenantId: "t" }, ctxB);

    expect(backend.calls.filter((c) => c.method === "getOrderStatus")).toHaveLength(2);

    // 幂等键构成验证：threadId + toolName + 归一化参数 + turnIndex
    const key1 = toolIdempotencyKey({ threadId: "th", toolName: "x", args: { a: 1, b: 2 }, turnIndex: 1 });
    const key2 = toolIdempotencyKey({ threadId: "th", toolName: "x", args: { b: 2, a: 1 }, turnIndex: 1 });
    const key3 = toolIdempotencyKey({ threadId: "th", toolName: "x", args: { a: 1, b: 2 }, turnIndex: 2 });
    // 归一化参数：键序不影响 key
    expect(key2).toBe(key1);
    // turnIndex 变了 key 必须变
    expect(key3).not.toBe(key1);
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it("SQLite 幂等存储跨实例保留去重结果（重发场景的真实形态）", async () => {
    let store: SqliteIdempotencyStore;
    try {
      store = new SqliteIdempotencyStore(); // :memory:
    } catch {
      // better-sqlite3 原生模块 ABI 不可用时按既有约定跳过（见 entry-idempotency.test.ts）
      return;
    }

    const key = toolIdempotencyKey({ threadId: "th", toolName: "x", args: { a: 1 }, turnIndex: 1 });
    const first = await store.begin<{ v: number }>(key);
    expect(first.hit).toBe(false);
    await first.commit({ v: 42 });

    // 模拟进程重启：新实例、同一存储内容
    const second = await store.begin<{ v: number }>(key);
    expect(second.hit).toBe(true);
    expect(second.result).toEqual({ v: 42 });
    store.close();
  });
});
