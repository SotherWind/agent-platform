/**
 * T1.4 编排器（Orchestrator）
 *
 * 依据 Diffco 阶段 4：只拼接不重做，且编排器无工具。
 *
 * 验收（清单 283 行）：
 * - 编排器无任何副作用能力
 * - 专家间不存在自然语言对话（Diffco 明确拒绝的模式）
 */
import {
  orchestrate,
  ORCHESTRATOR_TOOLS,
  resolveConflicts,
  joinAnswers,
} from "../nodes/orchestrator";
import type { SpecialistOutput } from "../schema";
import { createFakeLlm } from "../llm/fake";

const output = (overrides: Partial<SpecialistOutput> & { category: string }): SpecialistOutput => ({
  status: "resolved",
  answer: "",
  partialAnswer: "",
  gap: "",
  reason: "",
  toolRequests: [],
  rejectedToolRequests: [],
  citations: [],
  promptVersion: "v1",
  ...overrides,
});

describe("orchestratorNode", () => {
  it("只有多专家输出时才介入，单专家直通", async () => {
    const llm = createFakeLlm({ reply: JSON.stringify({ answer: "被改写过的答案" }) });
    const single = output({ category: "billing", answer: "单专家的完整答案" });

    const result = await orchestrate([single], { llm });

    // 直通：答案原样返回，模型一次都没被调
    expect(result.answer).toBe("单专家的完整答案");
    expect(result.usedModel).toBe(false);
    expect(llm.calls).toHaveLength(0);

    // 全部 escalate 时编排器也不介入
    const allEscalated = await orchestrate(
      [output({ category: "billing", status: "escalate", reason: "x" })],
      { llm },
    );
    expect(allEscalated.answer).toBe("");
    expect(llm.calls).toHaveLength(0);
  });

  it("编排器的工具清单为空", () => {
    expect(ORCHESTRATOR_TOOLS).toHaveLength(0);
    // 冻结常量：运行期也加不进工具（无副作用能力的代码级保证）
    expect(Object.isFrozen(ORCHESTRATOR_TOOLS)).toBe(true);
  });

  it("专家间通信载体是结构化对象，不是自然语言段落", async () => {
    const llm = createFakeLlm({ reply: JSON.stringify({ answer: "拼接结果" }) });
    const outputs = [
      output({ category: "billing", status: "needsOrchestrator", partialAnswer: "账单部分", gap: "缺配置" }),
      output({ category: "technical", answer: "技术部分" }),
    ];

    await orchestrate(outputs, { llm });

    expect(llm.calls).toHaveLength(1);
    const prompt = llm.calls[0].prompt;
    // 传入的是 JSON（结构化字段可见），不是自然语言段落
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"status"');
    expect(prompt).toContain('"gap"');
    // 能从中解析出结构化对象 —— 这是「不是自然语言」的可执行定义
    const jsonStart = prompt.indexOf("[");
    const jsonEnd = prompt.lastIndexOf("]");
    expect(jsonStart).toBeGreaterThan(-1);
    const parsed = JSON.parse(prompt.slice(jsonStart, jsonEnd + 1)) as Array<{ category: string }>;
    expect(parsed.map((o) => o.category)).toEqual(["billing", "technical"]);
  });

  it("专家结论冲突时按优先级规则消解并标记 conflictResolved", async () => {
    const outputs = [
      output({ category: "billing", answer: "账单结论" }), // priority 3
      output({ category: "technical", answer: "技术结论" }), // priority 4
    ];

    const result = await orchestrate(outputs, {}); // 无模型：确定性规则消解

    // 拼接按优先级排序：technical 在前
    expect(result.answer).toBe("技术结论\n\n账单结论");
    // 冲突被显式标记，而不是静默丢弃
    expect(result.conflictResolved.length).toBeGreaterThan(0);
    expect(result.conflictResolved.some((note) => note.includes("billing"))).toBe(true);
    expect(result.conflictResolved.some((note) => note.includes("technical"))).toBe(true);

    // 消解规则是纯函数：同样输入必然同样输出（可回放）
    expect(resolveConflicts(outputs)).toEqual(resolveConflicts(outputs));
    expect(joinAnswers(outputs)).toBe("技术结论\n\n账单结论");
  });
});
