/**
 * T6.1 降级链
 *
 * 依据 Swiggy：组件级 fallback + LLM 自动降级 + 向人工优雅降级。
 *
 * 验收（清单 612 行）：系统在任何单点故障下**仍有响应**。
 * （「不可重试错误不触发重试」已在 errors.test.ts 覆盖，此处补齐其余路径。）
 */
import { LlmFallbackChain } from "../llm/degradation";
import { createFakeLlm } from "../llm/fake";
import { buildGraph } from "../agent";
import { TenantMissingError, LlmTimeoutError } from "../errors";
import { rerank, retrieve } from "../nodes/retrieve";
import { Prefilter } from "../prefilter";
import type { RetrievedChunk } from "../schema";

const chunk = (id: string, score: number): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "t",
  content: `内容 ${id}`,
  score,
  metadata: {},
});

describe("降级链", () => {
  it("主 LLM 超时时自动切换备用模型", async () => {
    const primary = createFakeLlm({ model: "primary", failWith: new LlmTimeoutError("timeout") });
    const backup = createFakeLlm({ model: "backup", reply: "备用模型的回答" });
    const chain = new LlmFallbackChain([primary, backup]);

    const res = await chain.invoke({ prompt: "问题", stage: "generate" });

    expect(res.text).toBe("备用模型的回答");
    // 降级标记：结果与观测点都能看到
    expect(res.degraded).toBe(true);
    expect(res.fallbackFrom).toBe("primary");
  });

  it("全部模型不可用时返回固定话术并排队转人工", async () => {
    const a = createFakeLlm({ model: "a", failWith: new LlmTimeoutError("down") });
    const b = createFakeLlm({ model: "b", failWith: new LlmTimeoutError("down") });
    const events: Array<{ from: string; to: string | null; reason: string }> = [];
    const chain = new LlmFallbackChain([a, b], {
      onDegrade: (event) => events.push(event),
    });

    const res = await chain.invoke({ prompt: "问题", stage: "generate" });

    // 固定话术：可以答得不好，不能没有响应
    expect(res.text).toContain("转人工");
    expect(res.fallbackExhausted).toBe(true);
    expect(res.degraded).toBe(true);
    // 排队转人工的路径由编排层识别 fallbackExhausted → escalate（见全链路用例）

    // 图路径：全部模型不可用时终止并升级，而非崩溃
    const graph = await buildGraph({
      vectorStore: { search: async () => [chunk("c1", 0.9)], addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {} },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: {
        simple: createFakeLlm({ model: "s", failWith: new LlmTimeoutError("down") }),
        small: createFakeLlm({ model: "m", failWith: new LlmTimeoutError("down") }),
        large: createFakeLlm({ model: "l", failWith: new LlmTimeoutError("down") }),
      },
    });
    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t61-all-down", messages: [] },
      { configurable: { thread_id: "t61-all-down" } },
    );
    expect(result.route).toBe("escalate");
    expect(result.ticketId).toBeTruthy();
    expect(result.finalAnswer).toContain("人工");
  });

  it("Rerank 服务不可用时退化为纯向量序，不阻断回答", async () => {
    const chunks = [chunk("low", 0.2), chunk("high", 0.9), chunk("mid", 0.5)];

    // reranker 为 null：退化而不是报错
    const noReranker = await rerank(null, "q", chunks, 5);
    expect(noReranker.degraded).toBe(true);
    expect(noReranker.chunks.map((c) => c.id)).toEqual(["high", "mid", "low"]);

    // reranker 抛错（服务挂了）：同样退化
    const broken = await rerank(
      { rerank: async () => { throw new Error("rerank api down"); } },
      "q",
      chunks,
      5,
    );
    expect(broken.degraded).toBe(true);
    expect(broken.degradedReason).toContain("rerank api down");
    expect(broken.chunks.map((c) => c.id)).toEqual(["high", "mid", "low"]);

    // 图路径：reranker 挂掉仍能出答案
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
        specialist: JSON.stringify({ status: "resolved", answer: "回答" }),
        generate: "降级下的回答",
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });
    const graph = await buildGraph({
      vectorStore: { search: async () => chunks, addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {} },
      reranker: { rerank: async () => { throw new Error("rerank api down"); } },
      llms: { simple: model, small: model, large: model },
    });
    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t61-rerank", messages: [] },
      { configurable: { thread_id: "t61-rerank" } },
    );
    expect(result.finalAnswer).toContain("降级下的回答");
    expect(result.degradations.join()).toContain("rerank");
  });

  it("向量库不可用时降级为纯 FAQ 直答", async () => {
    // 向量库挂了：retrieve 不抛错，返回空 + 降级标记（上层据此兜底）
    const brokenStore = {
      search: async () => { throw new Error("qdrant down"); },
      addDocuments: async () => 0,
      ingestFile: async () => 0,
      deleteByDocumentId: async () => {},
    };
    const result = await retrieve(brokenStore, { query: "q", tenantId: "t" });
    expect(result.degraded).toBe(true);
    expect(result.chunks).toEqual([]);

    // 图路径：向量库挂掉时链路仍有响应 —— 检索空 → 兜底话术；FAQ 直答不经过检索
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
        specialist: JSON.stringify({ status: "resolved", answer: "回答" }),
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });
    const graph = await buildGraph({
      vectorStore: brokenStore,
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });
    const fallback = await graph.invoke(
      { query: "某个知识库里的问题", tenantId: "t", threadId: "t61-vs-down", messages: [] },
      { configurable: { thread_id: "t61-vs-down" } },
    );
    expect(fallback.finalAnswer).toContain("没有找到可靠依据");
    expect(model.callsFor("generate")).toHaveLength(0); // 兜底不烧模型

    // FAQ 直答在向量库挂掉时照常命中（前置层与向量库完全解耦）
    const prefilter = new Prefilter();
    const direct = prefilter.run("怎么开发票", { tenantId: "t" });
    expect(direct.action).toBe("direct");
    expect(direct.answer).toContain("发票管理");
  });

  it("任何降级都留下可观测标记", async () => {
    const primary = createFakeLlm({ model: "primary", failWith: new LlmTimeoutError("timeout") });
    const backup = createFakeLlm({ model: "backup", reply: "ok" });
    const events: Array<{ from: string; to: string | null; reason: string; retryable: boolean }> = [];
    const chain = new LlmFallbackChain([primary, backup], { onDegrade: (event) => events.push(event) });

    const res = await chain.invoke({ prompt: "q", stage: "generate" });

    // 事件流里有完整降级链路：from → to、原因、可重试性
    expect(events).toEqual([
      { from: "primary", to: "backup", reason: "timeout", retryable: true },
    ]);
    // 响应体同样带标记，随 state.degradations / span 落盘
    expect(res.degraded).toBe(true);
    expect(res.fallbackFrom).toBe("primary");
  });

  it("不可重试错误不触发重试（依据 AgentError.retryable）", async () => {
    const primary = createFakeLlm({ model: "primary", failWith: new TenantMissingError() });
    const backup = createFakeLlm({ model: "backup", reply: "不该被调用" });
    const chain = new LlmFallbackChain([primary, backup]);

    await expect(chain.invoke({ prompt: "q", stage: "generate" })).rejects.toBeInstanceOf(TenantMissingError);
    // 备用模型从未被尝试
    expect(backup.calls).toHaveLength(0);
    expect(primary.calls).toHaveLength(1);
  });
});
