import { MemorySaver } from "@langchain/langgraph";
import { createGraph } from "../index";
import { TenantMissingError } from "../errors";
import { createFakeLlm } from "../llm/fake";
import { buildGraph } from "../agent";
import { applyContextBudget } from "../nodes/budget";
import type { RetrievedChunk } from "../schema";

const doc = (id: string, tenantId = "tenant-a"): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId,
  content: `知识片段 ${id}`,
  score: 0.9,
  metadata: {},
});

function llm() {
  return createFakeLlm({
    byStage: {
      triage: JSON.stringify({
        categories: ["general"],
        urgency: "normal",
        likelyNeedsHuman: false,
        needsRealtimeData: false,
      }),
      rewrite: "退款规则",
      specialist: JSON.stringify({
        status: "resolved",
        answer: "请参考知识库中的退款规则。",
        citations: ["c1"],
      }),
      generate: "基于知识库，这是可核对的回答。",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

describe("核心编排图", () => {
  it("直接调用公开入口时没有鉴权身份会 fail-closed", async () => {
    const api = await createGraph({ reranker: null });
    await expect(api.invoke({ query: "你好", tenantId: "tenant-a", authenticated: false, history: [] })).rejects.toBeInstanceOf(TenantMissingError);
  });

  it("接入真实生成节点、预算、终审并保留租户引用", async () => {
    const model = llm();
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore: {
        search: async () => [doc("c1")],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_query, chunks) => chunks.map((chunk) => ({ ...chunk, rerankScore: chunk.score })) },
      llms: { simple: model, small: model, large: model },
      maxContextTokens: 100,
    });

    const result = await graph.invoke(
      { query: "退款规则", tenantId: "tenant-a", threadId: "thread-a", messages: [] },
      { configurable: { thread_id: "thread-a" } },
    );

    expect(model.callsFor("generate")).toHaveLength(1);
    expect(result.finalAnswer).toContain("可核对");
    expect(result.citations).toEqual([
      expect.objectContaining({ chunkId: "c1", tenantId: "tenant-a" }),
    ]);
    expect(result.review?.passed).toBe(true);
    expect(result.budget.contextTokens).toBeGreaterThanOrEqual(0);
  });

  it("空检索直接兜底，不调用生成模型", async () => {
    const model = llm();
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [],
        addDocuments: async () => 0,
        ingestFile: async () => 0,
        deleteByDocumentId: async () => {},
      },
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });

    const result = await graph.invoke({ query: "不存在的问题", tenantId: "tenant-a", threadId: "thread-empty", messages: [] }, { configurable: { thread_id: "thread-empty" } });
    expect(model.callsFor("generate")).toHaveLength(0);
    expect(result.finalAnswer).toContain("没有找到可靠依据");
  });

  it("公开流式入口先终审再发出，chunk 拼接等于 finalAnswer", async () => {
    const model = llm();
    const api = await createGraph({
      vectorStore: {
        search: async () => [doc("c1")],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });
    const chunks: string[] = [];
    for await (const chunk of api.stream({ query: "退款规则", tenantId: "tenant-a", authenticated: true, threadId: "stream-1", history: [] }, { configurable: { thread_id: "stream-1" } })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toContain("可核对");
    expect(model.callsFor("review")).toHaveLength(1);
  });

  it("同一 thread 的后续轮次读取 checkpoint，预算辅助函数不突破硬上限", async () => {
    const saver = new MemorySaver();
    const model = llm();
    const graph = await buildGraph({
      checkpointer: saver,
      vectorStore: {
        search: async () => [doc("c1")],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });

    const config = { configurable: { thread_id: "thread-memory" } };
    const first = await graph.invoke({ query: "第一轮", tenantId: "tenant-a", threadId: "thread-memory", messages: [] }, config);
    const second = await graph.invoke({ query: "第二轮", tenantId: "tenant-a", threadId: "thread-memory", messages: [] }, config);
    expect(first.threadId).toBe("thread-memory");
    expect(second.turnCount).toBeGreaterThan(first.turnCount);
    expect(applyContextBudget([{ ...doc("long"), rerankScore: 1, content: "很长的知识内容" }], { maxTokens: 0 }).tokens).toBe(0);
  });
});
