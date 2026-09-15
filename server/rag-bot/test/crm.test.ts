import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionDispatcher,
  ActionGuardrails,
  ActionSignalBus,
  InMemoryIdempotencyStore,
  ProposalService,
  createRefundTool,
} from "@agent-platform/rag-boot";
import { LocalCrmAdapter } from "../src/crm.js";
import { createPersistence } from "../src/persistence.js";

const openAdapters: LocalCrmAdapter[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const adapter of openAdapters.splice(0)) adapter.close();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("LocalCrmAdapter", () => {
  it("按租户隔离 CRM 对象，并允许不同租户使用同一个业务编号", async () => {
    const crm = new LocalCrmAdapter();
    openAdapters.push(crm);

    await expect(crm.getOrderStatus("order-demo-private", "tenant-demo")).resolves.toMatchObject({
      status: "shipped",
    });
    await expect(crm.getOrderStatus("order-demo-private", "tenant-other"))
      .rejects.toThrow("订单不存在");

    await expect(crm.getOrderStatus("order-demo-refund", "tenant-demo")).resolves.toMatchObject({
      status: "shipped",
    });
    await expect(crm.getOrderStatus("order-demo-refund", "tenant-other")).resolves.toMatchObject({
      status: "delivered",
    });

    await expect(crm.getAccountProfile("acct-demo", "tenant-other"))
      .rejects.toThrow("账户不存在");
  });

  it("退款在业务事务内幂等，并同步更新订单可退余额与状态", async () => {
    const crm = new LocalCrmAdapter();
    openAdapters.push(crm);

    const first = await crm.refund("order-demo-refund", 5_000, "tenant-demo", "op-refund-1");
    const repeated = await crm.refund("order-demo-refund", 5_000, "tenant-demo", "op-refund-1");

    expect(repeated).toEqual(first);
    expect(await crm.listRefunds("tenant-demo", "order-demo-refund")).toHaveLength(1);
    await expect(crm.getOrderStatus("order-demo-refund", "tenant-demo")).resolves.toMatchObject({
      status: "partially_refunded",
      refundableAmountCents: 24_900,
    });

    await expect(crm.refund("order-demo-refund", 30_000, "tenant-demo", "op-refund-too-much"))
      .rejects.toThrow("可退款金额不足");
    expect(await crm.listRefunds("tenant-demo", "order-demo-refund")).toHaveLength(1);

    await expect(crm.refund("order-demo-refund", 1_000, "tenant-demo", "op-refund-1"))
      .rejects.toThrow("幂等键");
  });

  it("套餐变更与凭证重置跨实例保留真实状态", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ragbot-crm-"));
    tempDirs.push(directory);
    const path = join(directory, "crm.sqlite");

    const first = new LocalCrmAdapter({ path });
    await first.changePlan("acct-demo", "enterprise", "tenant-demo", "op-plan-1");
    const credential = await first.resetCredential("integration-demo", "tenant-demo", "op-credential-1");
    first.close();

    const second = new LocalCrmAdapter({ path });
    openAdapters.push(second);
    await expect(second.getAccountProfile("acct-demo", "tenant-demo")).resolves.toMatchObject({
      plan: "enterprise",
    });
    await expect(second.getIntegrationStatus("acct-demo", "tenant-demo")).resolves.toMatchObject({
      connected: true,
      credentialVersion: 2,
    });
    await expect(second.resetCredential("integration-demo", "tenant-demo", "op-credential-1"))
      .resolves.toEqual(credential);
  });

  it("确认前不改 CRM，确认后经 signal 投递，重复 flush 不重复退款", async () => {
    const crm = new LocalCrmAdapter();
    openAdapters.push(crm);
    const tool = createRefundTool(crm);
    const proposals = new ProposalService({ secret: "local-crm-test-secret" });
    const signals = new ActionSignalBus();
    const dispatcher = new ActionDispatcher({
      proposals,
      signals,
      tools: [tool],
      idempotency: new InMemoryIdempotencyStore(),
      guardrails: new ActionGuardrails(),
    });
    const proposal = proposals.propose({
      action: tool.name,
      params: { orderId: "order-demo-refund", amountCents: 1_000 },
      summary: "退款",
      tenantId: "tenant-demo",
      threadId: "crm-flow",
      principal: "alice",
    });

    expect(await crm.listRefunds("tenant-demo", "order-demo-refund")).toHaveLength(0);
    await dispatcher.submit({
      proposalId: proposal.id,
      token: proposal.confirmToken,
      tenantId: proposal.tenantId,
      threadId: proposal.threadId,
      principal: proposal.principal,
    });
    expect(await crm.listRefunds("tenant-demo", "order-demo-refund")).toHaveLength(0);

    await dispatcher.flush();
    expect(await crm.listRefunds("tenant-demo", "order-demo-refund")).toHaveLength(1);
    expect((await signals.list())[0].status).toBe("acked");

    await dispatcher.flush();
    expect(await crm.listRefunds("tenant-demo", "order-demo-refund")).toHaveLength(1);
  });

  it("开发持久化装配默认包含本地 CRM，生产自定义业务模块不创建演示数据", () => {
    const directory = mkdtempSync(join(tmpdir(), "ragbot-persistence-"));
    tempDirs.push(directory);

    const development = createPersistence(directory);
    expect("crm" in development).toBe(true);
    development.close();

    const production = createPersistence(directory, { localCrm: false });
    expect("crm" in production).toBe(false);
    production.close();
  });
});
