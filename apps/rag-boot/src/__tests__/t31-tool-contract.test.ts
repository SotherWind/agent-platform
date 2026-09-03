/**
 * T3.1 工具契约与读写分级
 *
 * 验收（清单 386 行）：
 * - 查订单与改订单不共用权限
 * - 工具元信息可被 Guardrails（T4.2）读取
 */
import {
  assertToolContract,
  assertToolRegistry,
  executeTool,
  type AgentTool,
} from "../tools/contract";
import { defaultTools, FakeBackend, createRefundTool } from "../tools/business";
import { InMemoryIdempotencyStore } from "../tools/idempotency";
import { z } from "zod/v4";

const noopCtx = {
  tenantId: "t",
  threadId: "th",
  principal: "p",
  turnIndex: 1,
  idempotency: new InMemoryIdempotencyStore(),
  audit: () => {},
};

describe("工具契约", () => {
  it("每个工具声明 kind: 'read' | 'write'", () => {
    const backend = new FakeBackend();
    const tools = defaultTools(backend, async () => ({ id: "t1" }));

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(["read", "write"]).toContain(tool.kind);
      // 批量校验通过 = 契约完整（名称、schema、幂等声明等）
      expect(() => assertToolContract(tool)).not.toThrow();
    }
    // 注册表无重名
    expect(() => assertToolRegistry(tools)).not.toThrow();
  });

  it("write 类工具必须声明 requiresConfirmation", () => {
    const backend = new FakeBackend();

    // 缺 requiresConfirmation 的 write 工具：构造时就会被拒绝
    const badWrite = {
      name: "bad_write",
      description: "x",
      kind: "write",
      schema: z.object({}),
      domains: ["order"],
      idempotent: true,
      credential: { read: "r", write: "w" },
      execute: async () => ({}),
    } as unknown as AgentTool;
    expect(() => assertToolContract(badWrite)).toThrow(/requiresConfirmation/);

    // write 还必须幂等（T3.2 / MCP 2026-07-28）
    const nonIdempotent = { ...badWrite, requiresConfirmation: true, idempotent: false } as unknown as AgentTool;
    expect(() => assertToolContract(nonIdempotent)).toThrow(/idempotent/);

    // 正例：业务库里的 write 工具全部带 requiresConfirmation
    for (const tool of defaultTools(backend, async () => ({ id: "t1" }))) {
      if (tool.kind === "write") expect(tool.requiresConfirmation).toBe(true);
    }
  });

  it("write 类工具在未确认状态下调用会抛错", async () => {
    const backend = new FakeBackend();
    const refund = createRefundTool(backend);

    await expect(
      executeTool(refund, { orderId: "o", amountCents: 10, tenantId: "t" }, { ...noopCtx, confirmToken: undefined }),
    ).rejects.toThrow(/confirm/i);
    // 无副作用
    expect(backend.refunds).toHaveLength(0);
  });

  it("read 与 write 使用不同的凭证配置项", () => {
    const backend = new FakeBackend();
    const tools = defaultTools(backend, async () => ({ id: "t1" }));

    const readTool = tools.find((t) => t.name === "get_order_status")!;
    const writeTool = tools.find((t) => t.name === "propose_refund")!;

    // 读工具只配读凭证；写工具必须配写凭证
    expect(readTool.credential.read).toBeTruthy();
    expect(readTool.credential.write).toBeUndefined();
    expect(writeTool.credential.write).toBeTruthy();
    // 同一工具的读写凭证不可能是同一个值（查订单与改订单不共用权限）
    expect(writeTool.credential.write).not.toBe(readTool.credential.read);

    // 静态校验同样拦截：read 工具缺读凭证 / write 工具缺写凭证都不许注册
    const badRead = {
      name: "bad_read", description: "x", kind: "read", schema: z.object({}),
      domains: [], idempotent: true, credential: {}, execute: async () => ({}),
    } as unknown as AgentTool;
    expect(() => assertToolContract(badRead)).toThrow(/credential\.read/);

    const badWriteCred = {
      name: "bad_write2", description: "x", kind: "write", schema: z.object({}),
      domains: [], requiresConfirmation: true, idempotent: true, credential: { read: "r" },
      execute: async () => ({}),
    } as unknown as AgentTool;
    expect(() => assertToolContract(badWriteCred)).toThrow(/credential\.write/);
  });
});
