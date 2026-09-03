/**
 * T1.2 编排循环与轮次上限
 *
 * 依据：Swiggy 转 Agentic 的核心收益是有状态 + 图式节点；
 * 验证文档「必须补上」列明单会话最大工具调用轮次。
 *
 * 验收（清单 240 行）：
 * - 存在「无限自旋」的反例测试且能在有限步内终止
 * - 终止原因可观测
 */
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import type { Llm, LlmRequest, LlmResponse } from "../llm/types";
import { FakeBackend, createOrderStatusTool } from "../tools/business";
import { BudgetExceededError } from "../errors";

/**
 * 按「stage → 按调用顺序依次取用」的 fake LLM。
 * 取完最后一个后固定在最后一条——循环测试用它模拟
 * 「第一轮专家要工具、第二轮专家出结论」。
 */
function createSequencedLlm(byStageSeq: Record<string, string[]>): FakeSeqLlm {
  const counts: Record<string, number> = {};
  const calls: Array<{ stage?: string; prompt: string }> = [];
  return {
    model: "fake-seq",
    tier: "small",
    calls,
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      const stage = req.stage ?? "";
      const seq = byStageSeq[stage] ?? ["{}"];
      const idx = Math.min(counts[stage] ?? 0, seq.length - 1);
      counts[stage] = (counts[stage] ?? 0) + 1;
      calls.push({ stage, prompt: req.prompt });
      const promptTokens = 10;
      const completionTokens = 10;
      return {
        text: seq[idx],
        model: "fake-seq",
        tier: "small",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    },
  };
}

interface FakeSeqLlm extends Llm {
  calls: Array<{ stage?: string; prompt: string }>;
}

const OK_REVIEW = JSON.stringify({ passed: true, violations: [] });

function backend() {
  return new FakeBackend();
}

function vectorStore() {
  return {
    search: async () => [],
    addDocuments: async () => 0,
    ingestFile: async () => 0,
    deleteByDocumentId: async () => {},
  };
}

describe("编排循环", () => {
  it("工具结果回灌后能再次进入决策节点", async () => {
    const model = createSequencedLlm({
      triage: [
        JSON.stringify({
          categories: ["order"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: true,
        }),
      ],
      specialist: [
        // 第一轮：专家请求查订单（域内工具）
        JSON.stringify({
          status: "needsOrchestrator",
          partialAnswer: "",
          gap: "需要实时订单状态",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "tenant-a" } }],
        }),
        // 第二轮：工具结果已回灌（specialist prompt 里能看到工具返回），给出结论
        JSON.stringify({
          status: "resolved",
          answer: "你的订单 o-1 已经发货。",
          citations: [],
          toolRequests: [],
        }),
      ],
      generate: ["最终答复：你的订单已发货。"],
      review: [OK_REVIEW],
    });
    const backendInstance = backend();
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backendInstance)],
      maxToolTurns: 3,
    });

    const result = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "tenant-a", threadId: "t12-loop", messages: [] },
      { configurable: { thread_id: "t12-loop" } },
    );

    // 工具真的执行了一次
    expect(backendInstance.calls.filter((c) => c.method === "getOrderStatus")).toHaveLength(1);
    // 工具结果回灌后专家被再次进入（specialist 至少两次调用）
    expect(model.calls.filter((c) => c.stage === "specialist").length).toBeGreaterThanOrEqual(2);
    // 第二次专家调用的 prompt 中包含第一轮的工具返回
    const secondSpecialist = model.calls.filter((c) => c.stage === "specialist")[1];
    expect(secondSpecialist.prompt).toContain("get_order_status");
    expect(result.finalAnswer).toContain("已发货");
  });

  it("达到 maxToolTurns 时终止循环并走兜底，而非无限自旋", async () => {
    // 专家每轮都请求同一个工具 → 必然撞上轮次上限
    const model = createSequencedLlm({
      triage: [
        JSON.stringify({
          categories: ["order"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: true,
        }),
      ],
      specialist: [
        JSON.stringify({
          status: "needsOrchestrator",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "tenant-a" } }],
        }),
      ],
      review: [OK_REVIEW],
    });
    const backendInstance = backend();
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backendInstance)],
      maxToolTurns: 2,
    });

    const result = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "tenant-a", threadId: "t12-spin", messages: [] },
      { configurable: { thread_id: "t12-spin" } },
    );

    // 工具只被**执行**了 maxToolTurns 次（toolTurns 计数），不无限自旋。
    // 注意 backend 只有 1 次真实调用：第二轮同参重发被 T3.2 幂等键去重，
    // 正是「重发不会重复副作用」的预期行为，这里顺带构成 T3.2 的回归点。
    expect(backendInstance.calls.filter((c) => c.method === "getOrderStatus")).toHaveLength(1);
    expect(result.toolTurns).toBe(2);
    // 终止后走人工兜底，不伪造答案
    expect(result.route).toBe("escalate");
    expect(result.ticketId).toBeTruthy();
  });

  it("循环终止原因写入 state.terminationReason", async () => {
    const model = createSequencedLlm({
      triage: [
        JSON.stringify({
          categories: ["order"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: true,
        }),
      ],
      specialist: [
        JSON.stringify({
          status: "needsOrchestrator",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "tenant-a" } }],
        }),
      ],
      review: [OK_REVIEW],
    });
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backend())],
      maxToolTurns: 1,
    });

    const result = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "tenant-a", threadId: "t12-reason", messages: [] },
      { configurable: { thread_id: "t12-reason" } },
    );

    expect(result.terminationReason).toBe("max_tool_turns");
  });

  it("每轮消耗累加到 state.budget，超预算终止并按 budget_exceeded 升级人工", async () => {
    // 无检索上下文 + needsRealtimeData → 专家请求工具被预算拦下前，
    // 先验证预算字段的累加；再验证超预算路径的终止原因与升级触发。
    const model = createSequencedLlm({
      triage: [
        JSON.stringify({
          categories: ["general"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: false,
        }),
      ],
      specialist: [
        JSON.stringify({ status: "resolved", answer: "静态知识回答。" }),
      ],
      generate: ["静态回答。"],
      review: [OK_REVIEW],
    });
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      sessionTokenBudget: 5, // 极小预算：任何一轮都会超
      maxContextTokens: 1,
    });

    const result = await graph.invoke(
      { query: "退款规则是什么", tenantId: "tenant-a", threadId: "t12-budget", messages: [] },
      { configurable: { thread_id: "t12-budget" } },
    );

    // 预算是多轮累加的（triage/specialist/generate 各自消耗都进了 budget）
    expect(result.budget.llmCalls).toBeGreaterThanOrEqual(1);
    expect(result.budget.totalTokens).toBeGreaterThanOrEqual(result.budget.llmCalls);
    // 超预算：终止并升级，而不是继续烧 token
    expect(result.terminationReason).toBe("session_token_budget_exceeded");
    expect(result.escalation?.triggers).toContain("budget_exceeded");

    // BudgetExceededError 是不可重试错误（T0.3 契约：降级链不得重试预算类错误）
    expect(new BudgetExceededError("session budget exceeded").retryable).toBe(false);
  });
});
