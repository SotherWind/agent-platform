/**
 * T2.4 置信度与低置信兜底
 *
 * 架构图：知识问答产出「引用 + 置信度」，置信度是转人工触发条件之一（T5.1）。
 *
 * 实现要点（清单 365 行）：置信度用 rerank 分数 + 引用覆盖度组合，
 * 不用 LLM 自评（自评置信度不可靠）。
 *
 * 验收（清单 367 行）：阈值可配置；低置信路径与高置信路径行为可区分。
 */
import { computeConfidence, withConfidenceTone, LOW_CONFIDENCE_PREFIX } from "../nodes/confidence";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import { Tracer } from "../observability/tracer";
import type { RerankedChunk } from "../schema";

const chunk = (id: string, rerankScore: number): RerankedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "t",
  content: `内容 ${id}`,
  score: rerankScore,
  rerankScore,
  metadata: {},
});

function fullLlm() {
  return createFakeLlm({
    byStage: {
      triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
      specialist: JSON.stringify({ status: "resolved", answer: "回答" }),
      generate: "基于知识的回答。",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

describe("置信度", () => {
  it("rerank 最高分低于阈值时标记 lowConfidence", () => {
    // 阈值可配置：默认 0.35
    expect(computeConfidence([chunk("c1", 0.1)], { threshold: 0.35 }).lowConfidence).toBe(true);
    expect(computeConfidence([chunk("c1", 0.9)], { threshold: 0.35 }).lowConfidence).toBe(false);
    // 显式调高阈值后，同样的分数变成低置信 —— 阈值可配置
    expect(computeConfidence([chunk("c1", 0.9)], { threshold: 0.95 }).lowConfidence).toBe(true);

    // 反例防护：候选集只有一条时，相对归一化会把 0.1 算成满分 ——
    // 硬门槛（topScore < threshold）必须独立生效
    const single = computeConfidence([chunk("c1", 0.1)], { threshold: 0.35 });
    expect(single.topScore).toBe(0.1);
    expect(single.lowConfidence).toBe(true);

    // 空上下文必然低置信
    expect(computeConfidence([], {}).lowConfidence).toBe(true);
  });

  it("lowConfidence 时答案附带不确定表述，不做肯定断言", async () => {
    // 纯函数路径
    const toned = withConfidenceTone("答案是 X。", true);
    expect(toned).toContain(LOW_CONFIDENCE_PREFIX);
    expect(toned).toContain("可能不够完整");
    // 高置信不加免责声明（平白加会显得不自信）
    expect(withConfidenceTone("答案是 X。", false)).toBe("答案是 X。");

    // 图路径：低分检索 → 答案带不确定表述
    const model = fullLlm();
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [chunk("c1", 0.05)],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
    });
    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t24-low", messages: [] },
      { configurable: { thread_id: "t24-low" } },
    );

    expect(result.lowConfidence).toBe(true);
    expect(result.finalAnswer).toContain("可能不够完整");
  });

  it("lowConfidence 连续两轮触发转人工（与 T5.1 联动）", async () => {
    const model = fullLlm();
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [chunk("c1", 0.05)],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
    });
    const config = { configurable: { thread_id: "t24-repeat" } };

    const first = await graph.invoke(
      { query: "第一轮低置信问题", tenantId: "t", threadId: "t24-repeat", messages: [] },
      config,
    );
    expect(first.consecutiveLowConfidenceTurns).toBe(1);
    expect(first.route).not.toBe("escalate"); // 第一轮只标注，不升级

    const second = await graph.invoke(
      { query: "第二轮还是低置信", tenantId: "t", threadId: "t24-repeat", messages: [] },
      config,
    );
    expect(second.consecutiveLowConfidenceTurns).toBe(2);
    expect(second.route).toBe("escalate");
    expect(second.escalation?.triggers).toContain("low_confidence_repeat");
    expect(second.ticketId).toBeTruthy();
  });

  it("置信度写入 state 并进入 tracing", async () => {
    const model = fullLlm();
    const tracer = new Tracer();
    const graph = await buildGraph({
      tracer,
      vectorStore: {
        search: async () => [chunk("c1", 0.9)],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
      confidenceThreshold: 0.35,
    });

    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t24-trace", messages: [] },
      { configurable: { thread_id: "t24-trace" } },
    );

    // state 里有置信度
    expect(result.confidence).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(0.35);
    expect(result.lowConfidence).toBe(false);

    // tracing 里也有：置信度节点的 span 带 confidence / lowConfidence 属性
    const spans = tracer.forTrace(result.traceId);
    const confidenceSpan = spans.find((span) => span.attributes.confidence !== undefined);
    expect(confidenceSpan).toBeDefined();
    expect(confidenceSpan?.attributes.lowConfidence).toBe(false);
  });
});
