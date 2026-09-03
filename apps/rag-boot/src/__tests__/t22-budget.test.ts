/**
 * T2.2 Context Token 预算
 *
 * 依据 Fin：rerank 之后有 context budget filter，截断到约 1500 token 才进生成。
 *
 * 验收（清单 326 行）：
 * - 预算硬上限不可被突破
 * - token 用量可观测
 */
import { applyContextBudget, truncateHistory } from "../nodes/budget";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import { countTokens } from "../tokens";
import type { RerankedChunk } from "../schema";

const chunk = (id: string, rerankScore: number, content: string): RerankedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "t",
  content,
  score: rerankScore,
  rerankScore,
  metadata: {},
});

describe("context 预算", () => {
  it("累计 token 超预算时按 rerank 分数从低到高丢弃", () => {
    // 三条各约 20 token，预算只装得下两条 → 最低分被丢
    const chunks = [
      chunk("low", 0.10, "低分内容".repeat(12)),
      chunk("mid", 0.80, "中分内容".repeat(12)),
      chunk("high", 0.95, "高分内容".repeat(12)),
    ];
    const budget = countTokens(chunks[0].content) * 2 + 5;

    const result = applyContextBudget(chunks, { maxTokens: budget, maxChunks: 5 });

    expect(result.chunks.map((c) => c.id)).toEqual(["high", "mid"]);
    expect(result.dropped).toBe(1);
    expect(result.tokens).toBeLessThanOrEqual(budget);
  });

  it("单条 chunk 超预算时截断而非整条丢弃", () => {
    const huge = chunk("huge", 0.99, "很长的知识内容".repeat(500));
    const result = applyContextBudget([huge], { maxTokens: 50 });

    // 保住了最高分那条的信息（截断），而不是返回空上下文
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].id).toBe("huge");
    expect(result.truncated).toBe(1);
    // 预算硬上限不可被突破
    expect(result.tokens).toBeLessThanOrEqual(50);
    expect(countTokens(result.chunks[0].content)).toBeLessThanOrEqual(50);
  });

  it("最少保留 1 条最高分 chunk（预算极小时不返回空上下文）", () => {
    const chunks = [
      chunk("a", 0.9, "内容甲".repeat(50)),
      chunk("b", 0.8, "内容乙".repeat(50)),
    ];

    // 预算 1：装不下任何完整条目，但最高分那条仍被截断保留
    const result = applyContextBudget(chunks, { maxTokens: 1 });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].id).toBe("a");
  });

  it("实际进入 prompt 的 token 数写入 state 供成本核算", async () => {
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
        specialist: JSON.stringify({ status: "resolved", answer: "回答" }),
        generate: "回答",
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [chunk("c1", 0.9, "知识内容".repeat(20))],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
      maxContextTokens: 100,
    });

    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t22-state", messages: [] },
      { configurable: { thread_id: "t22-state" } },
    );

    // token 数写入 budget.contextTokens（T6.3 / T8.1 成本核算要用）
    expect(result.budget.contextTokens).toBeGreaterThan(0);
    expect(result.budget.contextTokens).toBeLessThanOrEqual(100);
  });

  it("历史消息按策略截断，系统消息永远保留", () => {
    const history = [
      { role: "system", content: "系统提示" },
      ...Array.from({ length: 25 }, (_, i) => ({ role: "user", content: `消息${i}` })),
    ];
    const truncated = truncateHistory(history, 20);

    expect(truncated.some((m) => m.role === "system")).toBe(true);
    expect(truncated.filter((m) => m.role !== "system")).toHaveLength(20);
    // 丢的是最早的，最近的消息保留
    expect(truncated[truncated.length - 1].content).toBe("消息24");
    expect(truncated.some((m) => m.content === "消息0")).toBe(false);
  });
});
