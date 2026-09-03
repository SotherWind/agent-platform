import { describe, expect, it } from "vitest";
import { IllegalTicketTransitionError, TicketService } from "../tickets";

/**
 * T5.4 工单生命周期
 *
 * 清单明确：工单不只是状态机，更是 T7.2 resolution rate 的数据底座——
 * 关闭不记解决方式就拒绝（宁可报错，不产脏数据），二次来访在创建时判定，
 * 评价回流关联到会话与专家类别。缺了这些，主指标算不出来，
 * 最终只能拿 deflection 凑数（Klarna 翻车机制）。
 */
describe("工单生命周期", () => {
  it("工单状态机只允许合法转移（open→assigned→pending→resolved→closed）", async () => {
    const service = new TicketService();
    const ticket = await service.create({ tenantId: "t1", threadId: "th1" });

    await service.transition({ ticketId: ticket.id, to: "assigned", by: "agent" });
    await service.transition({ ticketId: ticket.id, to: "pending", by: "human" });
    await service.transition({ ticketId: ticket.id, to: "resolved", by: "human" });
    const closed = await service.transition({ ticketId: ticket.id, to: "closed" });

    expect(closed.status).toBe("closed");
    // 完整转移历史落盘，可审计
    expect(closed.history.map((h) => h.to)).toEqual(["assigned", "pending", "resolved", "closed"]);
  });

  it("非法转移（closed→assigned）被拒绝", async () => {
    const service = new TicketService();
    const ticket = await service.create({ tenantId: "t1", threadId: "th1" });
    await service.transition({ ticketId: ticket.id, to: "closed" });

    // closed 是终态，不允许复活
    await expect(
      service.transition({ ticketId: ticket.id, to: "assigned" }),
    ).rejects.toBeInstanceOf(IllegalTicketTransitionError);
  });

  it("创建工单是 write 类操作，带幂等键，重复触发不产生两张单", async () => {
    const service = new TicketService();
    const first = await service.create({ tenantId: "t1", threadId: "th1", idempotencyKey: "key-1" });
    const second = await service.create({ tenantId: "t1", threadId: "th1", idempotencyKey: "key-1" });

    expect(second.id).toBe(first.id);
    const all = await service.list({ tenantId: "t1" });
    expect(all).toHaveLength(1);
  });

  it("工单关联 threadId，可从工单反查完整会话", async () => {
    const service = new TicketService();
    const ticket = await service.create({ tenantId: "t1", threadId: "thread-abc" });

    await expect(service.getThreadId(ticket.id)).resolves.toBe("thread-abc");
  });

  it("关闭时记录解决方式（agent-resolved / human-resolved / abandoned），供 T7.2 计算 resolutionRate", async () => {
    const service = new TicketService();
    const ticket = await service.create({ tenantId: "t1", threadId: "th1", humanInvolved: false });
    const closed = await service.close({ ticketId: ticket.id, resolution: "agent-resolved" });

    expect(closed.status).toBe("closed");
    expect(closed.resolution).toBe("agent-resolved");
    expect(closed.closedAt).not.toBeNull();
    // 关闭记录进 history，note 即解决方式
    const closeEntry = closed.history.find((h) => h.to === "closed");
    expect(closeEntry?.note).toBe("agent-resolved");
  });

  it("二次来访：同一 thread 关闭后再开新单被标记 secondVisit（resolutionRate 分母依据）", async () => {
    const service = new TicketService();
    const first = await service.create({ tenantId: "t1", threadId: "th1" });
    await service.close({ ticketId: first.id, resolution: "agent-resolved" });

    const second = await service.create({ tenantId: "t1", threadId: "th1" });
    expect(second.secondVisit).toBe(true);
    // 不同 thread 不受影响
    const fresh = await service.create({ tenantId: "t1", threadId: "th-other" });
    expect(fresh.secondVisit).toBe(false);
  });

  it("评价结果回流并可关联到具体会话与专家类别", async () => {
    const service = new TicketService();
    const ticket = await service.create({ tenantId: "t1", threadId: "th1", category: "billing" });
    await service.close({ ticketId: ticket.id, resolution: "agent-resolved" });

    const rated = await service.rate({ ticketId: ticket.id, rating: 4, comment: "解决了", category: "billing" });
    expect(rated.rating).toBe(4);
    expect(rated.ratingComment).toBe("解决了");
    // 评价落在工单上，工单带 threadId + category → 可回溯到具体会话与专家类别
    expect(rated.threadId).toBe("th1");
    expect(rated.ratingCategory).toBe("billing");
  });
});
