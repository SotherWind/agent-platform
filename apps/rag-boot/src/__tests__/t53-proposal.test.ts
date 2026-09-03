/**
 * T5.3 propose / confirm / execute 三段分离——专属测试
 *
 * 此前只有 security.test.ts 里一条组合用例，且 clock 固定在 1000，
 * 「proposal 带过期时间，过期后确认无效」（清单 625 行）的过期分支
 * 是**从未被执行过的代码**；「执行结果回写会话状态并可审计」（清单 628 行）
 * 的 audit 注入的是空函数，等于没验。本文件把这两条钉死。
 *
 * 可推进时钟是测过期分支的唯一正确姿势：固定时钟永远走不到过期路径。
 */
import { describe, expect, it } from "vitest";
import { ProposalService } from "../actions/proposal";
import { createRefundTool, FakeBackend } from "../tools/business";
import { executeTool } from "../tools/contract";
import { InMemoryIdempotencyStore } from "../tools/idempotency";

/** 可推进的时钟 */
function makeClock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function reasonCodeOf(err: unknown): string | undefined {
  return (err as { reasonCode?: string })?.reasonCode;
}

describe("T5.3 动作确认三段分离", () => {
  it("proposal 带过期时间，过期后确认无效", () => {
    const clock = makeClock(1000);
    const auditKinds: string[] = [];
    const service = new ProposalService({
      secret: "test",
      ttlMs: 500,
      clock: clock.now,
      onAudit: (entry) => auditKinds.push(entry.kind),
    });
    const proposal = service.propose({
      action: "refund",
      params: { orderId: "o", amountCents: 10, tenantId: "t" },
      summary: "退款",
      tenantId: "t",
      threadId: "th",
      principal: "p",
    });

    expect(proposal.status).toBe("pending");
    expect(proposal.expiresAt).toBe(1000 + 500);

    clock.advance(501); // 越过 expiresAt
    let caught: unknown;
    try {
      service.confirm({
        proposalId: proposal.id,
        token: proposal.confirmToken,
        threadId: "th",
        principal: "p",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(reasonCodeOf(caught)).toBe("proposal_expired");
    // 状态落盘为 expired（而非静默消失），过期本身也进审计
    expect(service.get(proposal.id)?.status).toBe("expired");
    expect(auditKinds).toContain("expire");
  });

  it("确认后、执行前过期，同样拒绝执行", async () => {
    const clock = makeClock(1000);
    const service = new ProposalService({
      secret: "test",
      ttlMs: 500,
      clock: clock.now,
    });
    const tool = createRefundTool(new FakeBackend());
    const proposal = service.propose({
      action: tool.name,
      params: { orderId: "o", amountCents: 10, tenantId: "t" },
      summary: "退款",
      tenantId: "t",
      threadId: "th",
      principal: "p",
    });
    const confirmed = service.confirm({
      proposalId: proposal.id,
      token: proposal.confirmToken,
      threadId: "th",
      principal: "p",
    });
    expect(confirmed.status).toBe("confirmed");

    clock.advance(501); // 确认有效，但拖到执行时已过期
    let caught: unknown;
    try {
      await service.execute(confirmed, tool, async (writeTool, input, token) =>
        executeTool(writeTool, input, {
          tenantId: "t",
          threadId: "th",
          principal: "p",
          turnIndex: 1,
          confirmToken: token,
          idempotency: new InMemoryIdempotencyStore(),
          audit: () => {},
        }).then((value) => value.result),
      );
    } catch (err) {
      caught = err;
    }
    expect(reasonCodeOf(caught)).toBe("proposal_expired");
  });

  it("执行结果回写会话状态并可审计（成功与失败两条路径）", async () => {
    const clock = makeClock(1000);
    const auditEntries: Array<{ kind: string; detail?: string }> = [];
    const service = new ProposalService({
      secret: "test",
      clock: clock.now,
      onAudit: (entry) => auditEntries.push({ kind: entry.kind, detail: entry.detail }),
    });
    const backend = new FakeBackend();
    const tool = createRefundTool(backend);
    const params = { orderId: "o", amountCents: 10, tenantId: "t" };

    // —— 成功路径 ——
    const proposal = service.propose({
      action: tool.name,
      params,
      summary: "退款",
      tenantId: "t",
      threadId: "th",
      principal: "p",
    });
    const confirmed = service.confirm({
      proposalId: proposal.id,
      token: proposal.confirmToken,
      threadId: "th",
      principal: "p",
    });
    const result = await service.execute(confirmed, tool, async (writeTool, input, token) =>
      executeTool(writeTool, input, {
        tenantId: "t",
        threadId: "th",
        principal: "p",
        turnIndex: 1,
        confirmToken: token,
        idempotency: new InMemoryIdempotencyStore(),
        audit: () => {},
      }).then((value) => value.result),
    );

    expect(result.ok).toBe(true);
    expect(result.deterministic).toBe(true); // 执行路径是确定性后端，不是 LLM
    // 状态回写：pending → confirmed → executed，从服务里可查
    expect(service.get(proposal.id)?.status).toBe("executed");
    // 全链路审计：propose → confirm → execute 一段不缺
    expect(auditEntries.map((e) => e.kind)).toEqual(["propose", "confirm", "execute"]);
    expect(backend.refunds).toHaveLength(1);

    // —— 失败路径：失败的执行也落审计（detail 带错误信息）——
    const failProposal = service.propose({
      action: tool.name,
      params,
      summary: "退款",
      tenantId: "t",
      threadId: "th-fail",
      principal: "p",
    });
    const failConfirmed = service.confirm({
      proposalId: failProposal.id,
      token: failProposal.confirmToken,
      threadId: "th-fail",
      principal: "p",
    });
    const failResult = await service.execute(failConfirmed, tool, async () => {
      throw new Error("backend unavailable");
    });
    expect(failResult.ok).toBe(false);
    expect(failResult.error).toContain("backend unavailable");
    const failedAudit = auditEntries.filter((e) => e.kind === "execute").at(-1);
    expect(failedAudit?.detail).toContain("backend unavailable");
    // 失败的副作用确实没有发生
    expect(backend.refunds).toHaveLength(1);
  });

  it("未确认的 proposal 直接进 execute 会被拒绝（类型与运行时双闸）", async () => {
    const service = new ProposalService({ secret: "test", clock: () => 1000 });
    const tool = createRefundTool(new FakeBackend());
    const proposal = service.propose({
      action: tool.name,
      params: { orderId: "o", amountCents: 10, tenantId: "t" },
      summary: "退款",
      tenantId: "t",
      threadId: "th",
      principal: "p",
    });
    // 跳过 confirm，直接拿 pending 的 proposal 去执行
    let caught: unknown;
    try {
      await service.execute(proposal, tool, async () => ({}));
    } catch (err) {
      caught = err;
    }
    expect(reasonCodeOf(caught)).toBe("not_confirmed");
  });
});
