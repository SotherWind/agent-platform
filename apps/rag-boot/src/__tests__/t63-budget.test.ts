/**
 * T6.3 预算硬约束
 *
 * 验收（清单 636 行）：单会话 token / 轮次双上限，历史不无限增长，成本可记录。
 */
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import type { Llm, LlmRequest, LlmResponse } from "../llm/types";
import { truncateHistory } from "../nodes/budget";
import { FakeBackend, createOrderStatusTool } from "../tools/business";

const OK_REVIEW = JSON.stringify({ passed: true, violations: [] });

function fullLlm() {
  return createFakeLlm({
    byStage: {
      triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
      specialist: JSON.stringify({ status: "resolved", answer: "回答" }),
      generate: "回答",
      review: OK_REVIEW,
    },
  });
}

function vectorStoreEmpty() {
  return {
    search: async () => [],
    addDocuments: async () => 0,
    ingestFile: async () => 0,
    deleteByDocumentId: async () => {},
  };
}

describe("成本预算", () => {
  it("单会话 token 预算超限时终止并兜底", async () => {
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [
          { id: "c1", documentId: "d1", tenantId: "t", content: "知识内容".repeat(50), score: 0.9, metadata: {} },
        ],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: fullLlm(), small: fullLlm(), large: fullLlm() },
      sessionTokenBudget: 1, // 极小预算：context 一进来就超
      maxContextTokens: 100,
    });

    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t63-token", messages: [] },
      { configurable: { thread_id: "t63-token" } },
    );

    // 终止 + 兜底（转人工），而不是继续烧 token
    expect(result.terminationReason).toBe("session_token_budget_exceeded");
    expect(result.escalation?.triggers).toContain("budget_exceeded");
    expect(result.finalAnswer).toContain("人工");
  });

  it("单会话工具调用轮次超限时终止", async () => {
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({ categories: ["order"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: true }),
        specialist: JSON.stringify({
          status: "needsOrchestrator",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "t" } }],
        }),
        review: OK_REVIEW,
      },
    });
    const backend = new FakeBackend();
    const graph = await buildGraph({
      vectorStore: vectorStoreEmpty(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backend)],
      maxToolTurns: 1,
    });

    const result = await graph.invoke(
      { query: "订单到哪了", tenantId: "t", threadId: "t63-turns", messages: [] },
      { configurable: { thread_id: "t63-turns" } },
    );

    expect(backend.calls).toHaveLength(1); // 只执行了一轮
    expect(result.toolTurns).toBe(1);
    expect(result.terminationReason).toBe("max_tool_turns");
    expect(result.route).toBe("escalate");
  });

  it("历史消息按策略截断，不无限增长", () => {
    const history = [
      { role: "system", content: "系统提示" },
      ...Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `消息${i}` })),
    ];
    const truncated = truncateHistory(history, 20);

    // 总量有界：system 保留 + 最近 20 条
    expect(truncated).toHaveLength(21);
    expect(truncated.filter((m) => m.role === "system")).toHaveLength(1);
    expect(truncated[truncated.length - 1].content).toBe("消息39");
  });

  it("每次会话产出成本记录", async () => {
    const graph = await buildGraph({
      vectorStore: vectorStoreEmpty(),
      reranker: null,
      llms: { simple: fullLlm(), small: fullLlm(), large: fullLlm() },
    });

    const result = await graph.invoke(
      { query: "退款规则是什么", tenantId: "t", threadId: "t63-cost", messages: [] },
      { configurable: { thread_id: "t63-cost" } },
    );

    // budget 是一次会话的完整成本记录：prompt / completion / total / 调用次数
    expect(result.budget.totalTokens).toBeGreaterThan(0);
    expect(result.budget.promptTokens).toBeGreaterThan(0);
    expect(result.budget.completionTokens).toBeGreaterThan(0);
    expect(result.budget.llmCalls).toBeGreaterThanOrEqual(3); // triage + specialist + generate + review
    expect(result.budget.totalTokens).toBe(
      result.budget.promptTokens + result.budget.completionTokens,
    );
  });
});
