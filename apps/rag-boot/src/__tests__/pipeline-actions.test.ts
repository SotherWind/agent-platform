import { MemorySaver } from "@langchain/langgraph";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import { ActionSignalBus } from "../actions/signal";
import { ProposalService } from "../actions/proposal";
import { ActionGuardrails } from "../guardrails/action";
import { createRefundTool, FakeBackend } from "../tools/business";

const fakeLlm = createFakeLlm({
  byStage: {
    triage: JSON.stringify({ categories: ["order"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: true }),
    specialist: JSON.stringify({ status: "resolved", answer: "已获取订单信息" }),
    generate: "已获取订单信息",
    review: JSON.stringify({ passed: true, violations: [] }),
  },
});

const vectorStore = {
  search: async () => [],
  addDocuments: async () => 0,
  ingestFile: async () => 0,
  deleteByDocumentId: async () => {},
};

describe("主图动作与工具安全接入", () => {
  it("动态问题没有工具请求时不会伪造回答，而是转人工", async () => {
    const graph = await buildGraph({ vectorStore, reranker: null, llms: { simple: fakeLlm, small: fakeLlm, large: fakeLlm }, maxToolTurns: 1 });
    const result = await graph.invoke({ query: "订单现在到哪里了？", tenantId: "t", threadId: "dynamic-no-tool", messages: [] }, { configurable: { thread_id: "dynamic-no-tool" } });
    expect(result.terminationReason).toBe("realtime_tool_required_but_not_requested");
    expect(result.ticketId).toBeTruthy();
  });

  it("动作 Guardrails 拦截未授权工具，不进入后端", async () => {
    const graph = await buildGraph({
      vectorStore,
      reranker: null,
      llms: { simple: fakeLlm, small: fakeLlm, large: fakeLlm },
      tools: [],
      actionGuardrails: new ActionGuardrails(),
    });
    const result = await graph.invoke({ query: "服务支持范围", tenantId: "t", threadId: "action-guardrail", messages: [] }, { configurable: { thread_id: "action-guardrail" } });
    expect(result.finalAnswer).toContain("转人工");
  });

  it("写动作只产生 proposal，不直接调用后端，也不绕过 signal bus", async () => {
    const backend = new FakeBackend();
    const refundTool = createRefundTool(backend);
    const proposalService = new ProposalService({ secret: "test" });
    const signalBus = new ActionSignalBus();
    const writeLlm = createFakeLlm({
      byStage: {
        triage: JSON.stringify({ categories: ["order"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
        specialist: JSON.stringify({ status: "needsOrchestrator", partialAnswer: "可以申请退款", toolRequests: [{ name: "propose_refund", args: { orderId: "o-1", amountCents: 10, tenantId: "t" } }] }),
        generate: "我可以帮你申请退款",
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore,
      reranker: null,
      llms: { simple: writeLlm, small: writeLlm, large: writeLlm },
      tools: [refundTool],
      proposalService,
      signalBus,
      actionGuardrails: new ActionGuardrails(),
    });
    const result = await graph.invoke({ query: "请退款", tenantId: "t", principal: "p", threadId: "write-proposal", messages: [] }, { configurable: { thread_id: "write-proposal" } });
    expect(result.actionProposals).toHaveLength(1);
    expect(result.actionProposals[0].status).toBe("pending");
    expect(backend.refunds).toHaveLength(0);
    expect(await signalBus.list()).toHaveLength(0);
    expect(result.finalAnswer).toContain(result.actionProposals[0].id);
  });
});
