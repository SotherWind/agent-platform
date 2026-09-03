/**
 * T4.2 动作侧 Guardrails（三点里最关键的一道）——专属测试
 *
 * 此前 Guardrails 三点摊在 security.test.ts 里，覆盖度不好审：
 * 「拦截结果带明确原因码写入审计日志」这条规格点（清单 556 行）漏了近一年没人钉。
 * 本文件把 T4.2 的 4 条规格逐条钉死；security.test.ts 保留为跨切面基线。
 *
 * 校验顺序（实现刻意固定）：清单 → 只读 → 身份账户 → principal → 金额 → 确认。
 */
import { describe, expect, it } from "vitest";
import {
  ActionGuardrails,
  type ActionGuardrailCode,
  type ActionGuardrailVerdict,
} from "../guardrails/action";

function expectDenied(verdict: ActionGuardrailVerdict, code: ActionGuardrailCode): void {
  if (verdict.allowed) {
    throw new Error(`expected denial with code=${code}, but action was allowed`);
  }
  expect(verdict.code).toBe(code);
  expect(verdict.reason).toBeTruthy();
}

describe("T4.2 动作侧 Guardrails", () => {
  it("拦截超出当前专家工具清单的动作提议", () => {
    const guardrails = new ActionGuardrails();
    // 集成专家试图调退款工具：清单外，直接拦
    expectDenied(
      guardrails.check({
        toolName: "refund",
        kind: "write",
        allowlist: ["get_integration_status"],
        principal: "p",
        confirmed: true,
      }),
      "tool_not_in_allowlist",
    );
    // 清单内 → 放行
    expect(
      guardrails.check({
        toolName: "get_integration_status",
        kind: "read",
        allowlist: ["get_integration_status"],
        confirmed: false,
      }).allowed,
    ).toBe(true);
  });

  it("拦截作用于非当前会话身份账户的动作", () => {
    const guardrails = new ActionGuardrails();
    expectDenied(
      guardrails.check({
        toolName: "refund",
        kind: "write",
        allowlist: ["refund"],
        targetAccount: "account-other",
        sessionAccount: "account-self",
        principal: "p",
        confirmed: true,
      }),
      "account_mismatch",
    );
    // 同账户 → 放行
    expect(
      guardrails.check({
        toolName: "refund",
        kind: "write",
        allowlist: ["refund"],
        targetAccount: "account-self",
        sessionAccount: "account-self",
        principal: "p",
        confirmed: true,
      }).allowed,
    ).toBe(true);
  });

  it("金额类动作超过阈值时强制人工审批", () => {
    const guardrails = new ActionGuardrails({ amountThresholdCents: 200_00 });
    // 恰好 200 元（等于阈值，未超过）→ 放行
    expect(
      guardrails.check({
        toolName: "refund",
        kind: "write",
        allowlist: ["refund"],
        amountCents: 200_00,
        principal: "p",
        confirmed: true,
      }).allowed,
    ).toBe(true);
    // 200.01 元（超过阈值）→ amount_threshold，升级人工
    expectDenied(
      guardrails.check({
        toolName: "refund",
        kind: "write",
        allowlist: ["refund"],
        amountCents: 200_01,
        principal: "p",
        confirmed: true,
      }),
      "amount_threshold",
    );
  });

  it("拦截结果带明确原因码写入审计日志，放行动作同样留痕", () => {
    // T4.2#4（清单 556 行）：此前只有原因码断言，审计写入完全没有断言
    const entries: Array<{
      at: number;
      code: ActionGuardrailCode | null;
      allowed: boolean;
      toolName: string;
      detail: string;
      principal?: string;
    }> = [];
    const guardrails = new ActionGuardrails({
      amountThresholdCents: 1000,
      clock: () => 1000,
      audit: (entry) => entries.push(entry),
    });

    // 一次拦截
    guardrails.check({
      toolName: "refund",
      kind: "write",
      allowlist: ["get_order_status"],
      principal: "p",
      confirmed: true,
    });
    // 一次放行
    guardrails.check({
      toolName: "get_order_status",
      kind: "read",
      allowlist: ["get_order_status"],
      principal: "p",
      confirmed: false,
    });

    // 拦截条目：allowed=false + 明确原因码 + 工具名 + 时间
    const denied = entries.find((e) => !e.allowed);
    expect(denied).toMatchObject({
      at: 1000,
      allowed: false,
      code: "tool_not_in_allowlist",
      toolName: "refund",
    });
    expect(denied?.detail).toContain("工具清单");

    // 放行条目也要落审计（allowed=true, code=null），审计不能只记坏事
    const allowed = entries.find((e) => e.allowed);
    expect(allowed).toMatchObject({
      at: 1000,
      allowed: true,
      code: null,
      toolName: "get_order_status",
      principal: "p",
    });
  });

  it("只读模式下写操作被拦截且不消耗后续校验", () => {
    const guardrails = new ActionGuardrails({ readOnlyMode: true });
    // 没给 principal / confirmed：只读拦截先于它们触发
    expectDenied(
      guardrails.check({
        toolName: "refund",
        kind: "write",
        allowlist: ["refund"],
        confirmed: false,
      }),
      "write_in_readonly_mode",
    );
  });
});
