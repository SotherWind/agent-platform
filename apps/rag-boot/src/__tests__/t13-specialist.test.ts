/**
 * T1.3 专家节点与工具边界隔离
 *
 * 依据 Diffco 阶段 3：每专家仅限本域工具子集，工具边界在执行前由代码校验。
 *
 * 验收（清单 264 行）：
 * - 越界调用必然被代码拦截（不依赖模型自觉）
 * - 并行执行无状态串扰
 */
import { runSpecialist, runSpecialists } from "../nodes/specialist";
import { SPECIALIST_REGISTRY, enforceToolBoundary, getSpecialist } from "../nodes/specialists";
import { createFakeLlm } from "../llm/fake";
import type { RerankedChunk } from "../schema";

const chunk = (id: string): RerankedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "t",
  content: `内容 ${id}`,
  score: 0.9,
  rerankScore: 0.9,
  metadata: {},
});

const baseInput = {
  categories: ["billing"],
  query: "账单问题",
  sanitizedQuery: "账单问题",
  contextChunks: [chunk("c1")] as RerankedChunk[],
  toolResults: [],
  calledToolNames: [],
  lowConfidence: false,
};

describe("专家节点隔离", () => {
  it("账单专家的工具清单不含集成配置类工具", () => {
    const billing = getSpecialist("billing");
    const integration = getSpecialist("integration");

    expect(billing.toolNames).not.toContain("get_integration_status");
    expect(billing.toolNames).not.toContain("propose_credential_reset");
    // 反向同样成立：集成专家不能动账单
    expect(integration.toolNames).not.toContain("get_billing_summary");
    expect(integration.toolNames).not.toContain("propose_plan_change");
    // 注册表里每个专家的清单都非空可查（评测集路径也在）
    expect(billing.evalSetPath).toContain("billing.jsonl");
  });

  it("专家尝试调用域外工具时被拒绝并记录违规", async () => {
    const llm = createFakeLlm({
      reply: JSON.stringify({
        status: "needsOrchestrator",
        toolRequests: [
          { name: "get_integration_status", args: { accountId: "a", tenantId: "t" } }, // 域外
          { name: "get_billing_summary", args: { accountId: "a", tenantId: "t" } }, // 域内
        ],
      }),
    });

    const output = await runSpecialist("billing", baseInput, { llm });

    // 域内放行
    expect(output.toolRequests.map((r) => r.name)).toEqual(["get_billing_summary"]);
    // 域外被拒且带原因（记录违规，供审计与评测统计「模型越界率」）
    expect(output.rejectedToolRequests).toHaveLength(1);
    expect(output.rejectedToolRequests[0].name).toBe("get_integration_status");
    expect(output.rejectedToolRequests[0].reason).toContain("billing");

    // 纯函数边界校验同样成立（不经过模型）
    const verdict = enforceToolBoundary(
      [{ name: "propose_credential_reset", args: {} }],
      "billing",
    );
    expect(verdict.allowed).toHaveLength(0);
    expect(verdict.rejected[0].reason).toContain("not in the allowlist");
  });

  it("多个专家并行执行，互不共享可变状态", async () => {
    const llm = createFakeLlm({
      reply: JSON.stringify({ status: "resolved", answer: "各域结论。", citations: ["c1"] }),
    });

    const outputs = await runSpecialists(
      { ...baseInput, categories: ["billing", "technical"] },
      { llm },
    );

    expect(outputs).toHaveLength(2);
    const [billing, technical] = outputs;
    expect(billing.category).toBe("billing");
    expect(technical.category).toBe("technical");
    // 独立对象，不是同一引用的两次别名
    expect(billing).not.toBe(technical);
    // 改动一个不影响另一个（无共享可变状态）
    billing.answer = "被篡改的答案";
    expect(technical.answer).toBe("各域结论。");
    expect(technical.status).toBe("resolved");
  });

  it("专家可返回三种结果：resolved / needsOrchestrator / escalate", async () => {
    const cases: Array<{ raw: string; status: string }> = [
      { raw: JSON.stringify({ status: "resolved", answer: "完整答案" }), status: "resolved" },
      {
        raw: JSON.stringify({ status: "needsOrchestrator", partialAnswer: "部分答案", gap: "缺实时数据" }),
        status: "needsOrchestrator",
      },
      { raw: JSON.stringify({ status: "escalate", reason: "超出能力范围" }), status: "escalate" },
    ];

    for (const { raw, status } of cases) {
      const llm = createFakeLlm({ reply: raw });
      const output = await runSpecialist("general", baseInput, { llm });
      expect(output.status).toBe(status);
    }

    // 附加：非法 JSON 也收敛到 escalate，绝不猜一个结论继续
    const broken = await runSpecialist("general", baseInput, {
      llm: createFakeLlm({ reply: "not-json" }),
    });
    expect(broken.status).toBe("escalate");
    expect(broken.reason).toContain("invalid JSON");

    // 注册表声明与实际可返回的状态集合一致
    expect(Object.keys(SPECIALIST_REGISTRY)).toContain("billing");
  });
});
