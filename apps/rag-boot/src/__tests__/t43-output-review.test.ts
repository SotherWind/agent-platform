/**
 * T4.3 输出侧 Guardrails 与终审 Reviewer——专属测试
 *
 * 清单 T4.3 五条规格逐条钉死。此前「检出绝对化用语等广告法风险表述」
 * （清单 568 行，ABSOLUTE_CLAIM_PATTERNS）全库无断言——本文件补上。
 * 「Reviewer 不通过时携带草稿转人工」联动 T5.2 交接包验证草稿不丢弃。
 */
import { describe, expect, it } from "vitest";
import { checkOutput, Reviewer } from "../guardrails/output";
import { buildHandoffPackage, evaluateEscalation } from "../escalation";
import { createFakeLlm } from "../llm/fake";
import type { AnswerCitation } from "../schema";

const citation = (text: string): AnswerCitation[] => [
  { chunkId: "c1", documentId: "d1", tenantId: "t", text },
];

function expectViolation(codes: string[], code: string): void {
  expect(codes).toContain(code);
}

describe("T4.3 输出侧 Guardrails 与 Reviewer", () => {
  it("答案中出现未在 citations 中的账户数字时判定不通过", () => {
    const result = checkOutput({
      answer: "已为您退款 129.00 元，订单 12345678 已关闭",
      citations: citation("退款会在几个工作日内到账"),
    });
    expect(result.passed).toBe(false);
    expectViolation(
      result.violations.map((v) => v.code),
      "ungrounded_numbers",
    );
    // 引用里出现的数字不算凭空捏造
    const ok = checkOutput({
      answer: "已为您退款 129.00 元",
      citations: citation("退款金额 129.00 元将在 3 个工作日内到账"),
    });
    expect(ok.violations.some((v) => v.code === "ungrounded_numbers")).toBe(false);
  });

  it("检出虚假承诺（『一定』『保证』『百分百』）并要求改写", () => {
    for (const phrase of ["一定能解决", "保证到账", "百分百成功"]) {
      const result = checkOutput({ answer: `我们${phrase}。` });
      expect(result.passed).toBe(false);
      expectViolation(
        result.violations.map((v) => v.code),
        "overpromise",
      );
    }
  });

  it("检出绝对化用语等广告法风险表述", () => {
    // T4.3#3（清单 568 行）：此前全库无断言
    for (const phrase of ["全网最佳", "行业第一品牌", "唯一选择", "最低价"]) {
      const result = checkOutput({ answer: `我们的服务是${phrase}。` });
      expect(result.passed).toBe(false);
      expectViolation(
        result.violations.map((v) => v.code),
        "absolute_claim",
      );
      expect(result.violations.find((v) => v.code === "absolute_claim")?.matched).toBeTruthy();
    }
  });

  it("提议了需确认动作却未附确认入口时判定不通过", () => {
    const result = checkOutput({
      answer: "我可以为您办理退款。",
      hasActionProposal: true,
      hasConfirmationEntry: false,
    });
    expect(result.passed).toBe(false);
    expectViolation(
      result.violations.map((v) => v.code),
      "missing_confirmation",
    );
    // 附了确认入口 → 通过
    const ok = checkOutput({
      answer: "我可以为您办理退款。",
      hasActionProposal: true,
      hasConfirmationEntry: true,
    });
    expect(ok.passed).toBe(true);
  });

  it("Reviewer 不通过时携带草稿转人工，而不是直接丢弃", async () => {
    // 有模型 + 模型两轮终审都判不通过 → verdict.passed=false，attempts 达上限
    const model = createFakeLlm({
      reply: JSON.stringify({
        passed: false,
        violations: [{ code: "tone", detail: "措辞不当" }],
      }),
    });
    const reviewer = new Reviewer({ llm: model, maxAttempts: 2 });
    const draft = "这个问题的答案写的有点随意";
    const verdict = await reviewer.review({ answer: draft, citations: [] });

    expect(verdict.passed).toBe(false);
    expect(verdict.attempts).toBe(2);
    expect(model.callsFor("review")).toHaveLength(2); // 两次终审都真的跑了模型

    // 关键行为（清单 570 行）：草稿不丢弃——调用方拿着 verdict + 原 answer
    // 直接建交接包（T5.2），人工是在编辑草稿而非从零开始
    const handoff = buildHandoffPackage({
      threadId: "th-review-fail",
      tenantId: "t",
      transcript: [
        { role: "user", content: "帮我处理", at: 1 },
        { role: "assistant", content: draft, at: 2 },
      ],
      draftReply: draft,
      decision: evaluateEscalation({ consecutiveReviewFailures: 2 }),
    });
    expect(handoff.draftReply).toBe(draft);
    expect(handoff.transcript.some((entry) => entry.content === draft)).toBe(true);
  });

  it("确定性检查不过时直接短路，不消耗终审模型", async () => {
    const model = createFakeLlm({ reply: JSON.stringify({ passed: true, violations: [] }) });
    const reviewer = new Reviewer({ llm: model, maxAttempts: 2 });
    const verdict = await reviewer.review({ answer: "保证退款", citations: [] });

    expect(verdict.passed).toBe(false);
    expect(verdict.source).toBe("deterministic");
    expect(model.callsFor("review")).toHaveLength(0); // 规则能抓的就不花钱
  });
});
