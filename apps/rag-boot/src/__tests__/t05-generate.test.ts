/**
 * T0.5 generateNode 接真实 LLM
 *
 * 补清单四条验收里此前没有断言的两条（第 2、4 条）：
 *   - prompt 中包含 reranked 上下文与租户约束
 *   - LLM 抛错时向上抛 LlmTimeoutError 而非静默返回空串
 * 第 4 条按错误来源拆成三个用例，覆盖 generate.ts 里此前从未被执行的三行：
 * 普通错误包装（166）、LlmTimeoutError 原样透传（165）、空输出抛错（175）。
 */
import { describe, expect, it } from "vitest";
import { generate } from "../nodes/generate";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import { LlmTimeoutError } from "../errors";
import type { RetrievedChunk } from "../schema";

const chunk = (id: string, content: string, score: number): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "tenant-a",
  content,
  score,
  metadata: {},
});

const baseInput = {
  query: "退款规则",
  sanitizedQuery: "退款规则",
  tenantId: "tenant-a",
  contextChunks: [{ ...chunk("c1", "知识片段 c1", 0.9), rerankScore: 0.9 }],
  lowConfidence: false,
};

describe("T0.5 generateNode", () => {
  it("prompt 中包含 reranked 上下文与租户约束", async () => {
    // 检索顺序 c1 在前；reranker 把 c2 提到最前 —— prompt 里必须体现 rerank 后的顺序，
    // 否则「上下文已按租户过滤并重排」这条保证在提示词层面是空的。
    const model = createFakeLlm({
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
          answer: "请参考知识库。",
          citations: ["c1"],
        }),
        generate: "基于知识库，这是可核对的回答。",
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });

    const graph = await buildGraph({
      vectorStore: {
        search: async () => [
          chunk("c1", "排序靠后的知识", 0.9),
          chunk("c2", "排序靠前的知识", 0.1),
        ],
        addDocuments: async () => 2,
        ingestFile: async () => 2,
        deleteByDocumentId: async () => {},
      },
      reranker: {
        rerank: async (_query, chunks) =>
          [...chunks]
            .reverse()
            .map((c) => ({ ...c, rerankScore: c.id === "c2" ? 0.99 : 0.5 })),
      },
      llms: { simple: model, small: model, large: model },
    });

    await graph.invoke(
      { query: "退款规则", tenantId: "tenant-a", threadId: "t05", messages: [] },
      { configurable: { thread_id: "t05" } },
    );

    const call = model.callsFor("generate")[0];
    expect(call).toBeDefined();
    const system = call!.system ?? "";

    // 租户约束（GENERATE_PROMPT 硬规则第 2 条）
    expect(system).toContain("tenant-a");
    expect(system).toContain("不得");
    expect(system).toContain("其他租户");
    // reranked 上下文：两段都在，且 rerank 后的顺序（c2 在前）
    expect(system).toContain("排序靠前的知识");
    expect(system).toContain("排序靠后的知识");
    expect(system.indexOf("排序靠前的知识")).toBeLessThan(
      system.indexOf("排序靠后的知识"),
    );
  });

  it("LLM 抛普通错误时包装为 LlmTimeoutError", async () => {
    const llm = createFakeLlm({ failWith: new Error("upstream 500") });
    await expect(generate(baseInput, { llm })).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it("LLM 本身就抛 LlmTimeoutError 时原样透传，不二次包装", async () => {
    const original = new LlmTimeoutError("already timed out", { stage: "generate" });
    const llm = createFakeLlm({ failWith: original });
    // 透传的意义：降级链靠 retryable / stage 决策，二次包装会丢掉原始上下文
    await expect(generate(baseInput, { llm })).rejects.toBe(original);
  });

  it("LLM 返回空输出时抛 LlmTimeoutError，不静默返回空串", async () => {
    const llm = createFakeLlm({ byStage: { generate: "   " } });
    await expect(generate(baseInput, { llm })).rejects.toBeInstanceOf(LlmTimeoutError);
  });
});
