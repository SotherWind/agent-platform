/**
 * T3.3 强制工具调用（禁止凭记忆作答）
 *
 * 依据 Swiggy 踩坑：Agent 误以为记忆里已有数据而不调工具，返回过期信息。
 * 修法是「强制至少调一个工具，而不是让工具调用可选」。
 *
 * 验收（清单 427 行）：最后一条是 Swiggy 原始 bug 的回归测试，必须过。
 */
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import type { Llm, LlmRequest, LlmResponse } from "../llm/types";
import { FakeBackend, createOrderStatusTool } from "../tools/business";

/** 按 stage → 调用序依次取用回复的 fake LLM */
function createSequencedLlm(byStageSeq: Record<string, string[]>): Llm & { calls: Array<{ stage?: string }> } {
  const counts: Record<string, number> = {};
  const calls: Array<{ stage?: string }> = [];
  return {
    model: "fake-seq",
    tier: "small",
    calls,
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      const stage = req.stage ?? "";
      const seq = byStageSeq[stage] ?? ["{}"];
      const idx = Math.min(counts[stage] ?? 0, seq.length - 1);
      counts[stage] = (counts[stage] ?? 0) + 1;
      calls.push({ stage });
      return {
        text: seq[idx],
        model: "fake-seq",
        tier: "small",
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      };
    },
  } as Llm & { calls: Array<{ stage?: string }> };
}

const REALTIME_TRIAGE = JSON.stringify({
  categories: ["order"],
  urgency: "normal",
  likelyNeedsHuman: false,
  needsRealtimeData: true,
});
const STATIC_TRIAGE = JSON.stringify({
  categories: ["general"],
  urgency: "normal",
  likelyNeedsHuman: false,
  needsRealtimeData: false,
});
const OK_REVIEW = JSON.stringify({ passed: true, violations: [] });

function vectorStore() {
  return {
    search: async () => [],
    addDocuments: async () => 0,
    ingestFile: async () => 0,
    deleteByDocumentId: async () => {},
  };
}

describe("动态数据强制取数", () => {
  it("triage 判定 needsRealtimeData 时，未调用工具就生成答案会被拦截", async () => {
    // 专家直接给出「resolved」却没请求任何工具 → 拦截，转人工
    const model = createSequencedLlm({
      triage: [REALTIME_TRIAGE],
      specialist: [JSON.stringify({ status: "resolved", answer: "凭记忆瞎答：订单已发货" })],
      review: [OK_REVIEW],
    });
    const backend = new FakeBackend();
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backend)],
    });

    const result = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "t", threadId: "t33-block", messages: [] },
      { configurable: { thread_id: "t33-block" } },
    );

    // 伪造答案没有发给用户；后端也没被调用过（数据根本没取）
    expect(result.finalAnswer).not.toContain("凭记忆瞎答");
    expect(backend.calls).toHaveLength(0);
    expect(result.terminationReason).toBe("realtime_tool_required_but_not_requested");
    expect(result.route).toBe("escalate");
  });

  it("拦截后强制回到工具调用节点重试", async () => {
    // 专家第一轮请求工具，说明「强制」机制把流程推回了工具节点
    const model = createSequencedLlm({
      triage: [REALTIME_TRIAGE],
      specialist: [
        JSON.stringify({
          status: "needsOrchestrator",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "t" } }],
        }),
        JSON.stringify({ status: "resolved", answer: "基于实时查询的回答" }),
      ],
      generate: ["基于实时查询的最终回答"],
      review: [OK_REVIEW],
    });
    const backend = new FakeBackend();
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backend)],
      maxToolTurns: 3,
    });

    const result = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "t", principal: "p", threadId: "t33-retry", messages: [] },
      { configurable: { thread_id: "t33-retry" } },
    );

    // 工具节点真的被执行，specialist 被再次进入
    expect(backend.calls.filter((c) => c.method === "getOrderStatus")).toHaveLength(1);
    expect(model.calls.filter((c) => c.stage === "specialist").length).toBeGreaterThanOrEqual(2);
    expect(result.toolsCalledThisTurn).toBe(true);
  });

  it("静态知识类问题不强制调工具", async () => {
    const model = createSequencedLlm({
      triage: [STATIC_TRIAGE],
      specialist: [JSON.stringify({ status: "resolved", answer: "退款规则是……" })],
      generate: ["退款规则是……（基于知识库）"],
      review: [OK_REVIEW],
    });
    const backend = new FakeBackend();
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [
          { id: "c1", documentId: "d1", tenantId: "t", content: "退款规则", score: 0.9, metadata: {} },
        ],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backend)],
    });

    const result = await graph.invoke(
      { query: "退款规则是什么", tenantId: "t", threadId: "t33-static", messages: [] },
      { configurable: { thread_id: "t33-static" } },
    );

    // 静态问题：零工具调用，正常走完生成
    expect(backend.calls).toHaveLength(0);
    expect(result.finalAnswer).toContain("退款规则");
    expect(result.route).not.toBe("escalate");
  });

  it("上一轮的订单状态不会被当作本轮的最新状态复用（Swiggy 原始 bug 回归）", async () => {
    // 来源：Swiggy 踩坑——Agent 误以为记忆里已有数据而不调工具，返回过期信息。
    // 第一轮查过订单（工具结果落在 toolCalls，turnIndex=1）；
    // 第二轮再问实时问题时，若专家不再请求工具，必须拦截转人工，
    // 绝不允许把第一轮的 toolCalls 当作本轮的最新状态复用。
    const model = createSequencedLlm({
      triage: [REALTIME_TRIAGE],
      specialist: [
        // 第一轮：正常请求工具
        JSON.stringify({
          status: "needsOrchestrator",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "t" } }],
        }),
        // 第二轮：偷懒不请求工具，直接「复用记忆」
        JSON.stringify({ status: "resolved", answer: "凭第一轮记忆：订单已发货" }),
      ],
      review: [OK_REVIEW],
    });
    const backend = new FakeBackend();
    const graph = await buildGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [createOrderStatusTool(backend)],
      maxToolTurns: 3,
    });
    const config = { configurable: { thread_id: "t33-stale" } };

    const first = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "t", principal: "p", threadId: "t33-stale", messages: [] },
      config,
    );
    expect(backend.calls).toHaveLength(1);
    expect(first.toolsCalledThisTurn).toBe(true);

    // 第二轮：turnStart 重置 toolsCalledThisTurn；上一轮 toolCalls 虽还在 state 里，
    // 但 turnIndex 不再等于本轮 turnCount → currentTurnToolCalls 为空 → 拦截
    const second = await graph.invoke(
      { query: "现在呢？再帮我查一次订单", tenantId: "t", principal: "p", threadId: "t33-stale", messages: [] },
      config,
    );

    // 伪造就没发出去；后端也没有「因为上一轮查过就跳过」
    expect(second.finalAnswer).not.toContain("凭第一轮记忆");
    expect(second.finalAnswer).toContain("转人工");
    expect(second.terminationReason).toBe("realtime_tool_required_but_not_requested");
  });
});
