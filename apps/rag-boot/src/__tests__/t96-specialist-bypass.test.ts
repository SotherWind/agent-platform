/**
 * T9.5 专家直通（specialistPolicy = "skipSingleCategory"）
 *
 * - 单类别 + 无实时数据需求 → 跳过 specialist/orchestration，generate 直接基于检索上下文生成
 * - 多类别 → 仍走完整专家管线
 * - 默认策略 "always" → 行为完全不变
 */
import { MemorySaver } from "@langchain/langgraph";
import { createGraph } from "../index";
import { admittedInput } from "./helpers/admitted-input";
import { Tracer } from "../observability/tracer";
import { createFakeLlm } from "../llm/fake";
import type { RetrievedChunk } from "../schema";

const TRIAGE_SINGLE = JSON.stringify({
  categories: ["billing"],
  urgency: "normal",
  likelyNeedsHuman: false,
  needsRealtimeData: false,
});

const TRIAGE_MULTI = JSON.stringify({
  categories: ["billing", "order"],
  urgency: "normal",
  likelyNeedsHuman: false,
  needsRealtimeData: false,
});

const DRAFT = "退款会在 1-3 个工作日内原路退回。";

function stagedModel() {
  return createFakeLlm({
    byStage: {
      triage: TRIAGE_SINGLE,
      specialist: JSON.stringify({ status: "resolved", answer: DRAFT }),
      generate: DRAFT,
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

function multiModel() {
  return createFakeLlm({
    byStage: {
      triage: TRIAGE_MULTI,
      specialist: JSON.stringify({ status: "resolved", answer: DRAFT }),
      generate: DRAFT,
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

const vectorStore = () => ({
  search: async (): Promise<RetrievedChunk[]> => [
    { id: "c1", documentId: "doc-c1", tenantId: "tenant-a", content: "退款 1-3 个工作日原路退回", score: 0.9, metadata: {} },
  ],
  addDocuments: async () => 1,
  ingestFile: async () => 1,
  deleteByDocumentId: async () => {},
});

const INPUT = {
  query: "退款多久到账？",
  tenantId: "tenant-a",
  authenticated: true,
  threadId: "t96",
  history: [] as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
};

describe("T9.5 专家直通（skipSingleCategory）", () => {
  it("单类别查询跳过 specialist/orchestration，generate 直接基于上下文回答", async () => {
    const tracer = new Tracer();
    const api = await createGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: stagedModel(), small: stagedModel(), large: stagedModel() },
      specialistPolicy: "skipSingleCategory",
      tracer,
      checkpointer: new MemorySaver(),
    });

    let answer = "";
    for await (const event of api.streamTokens(
      admittedInput({ ...INPUT, threadId: "t96-bypass" }),
      { configurable: { thread_id: "t96-bypass" } },
      { mode: "chunked" },
    )) {
      if (event.type === "final") answer = event.answer;
    }

    expect(answer).toBe(DRAFT);
    // 专家/编排节点没有 span —— 被真正跳过
    expect(tracer.forStage("specialist")).toHaveLength(0);
    expect(tracer.forStage("orchestrate")).toHaveLength(0);
    // generate/review 正常执行
    expect(tracer.forStage("generate")).toHaveLength(1);
    expect(tracer.forStage("review")).toHaveLength(1);
  });

  it("多类别查询仍走完整专家管线", async () => {
    const tracer = new Tracer();
    const api = await createGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: multiModel(), small: multiModel(), large: multiModel() },
      specialistPolicy: "skipSingleCategory",
      tracer,
      checkpointer: new MemorySaver(),
    });

    let answer = "";
    for await (const event of api.streamTokens(
      admittedInput({ ...INPUT, threadId: "t96-multi" }),
      { configurable: { thread_id: "t96-multi" } },
      { mode: "chunked" },
    )) {
      if (event.type === "final") answer = event.answer;
    }

    expect(answer).toBe(DRAFT);
    expect(tracer.forStage("specialist").length).toBeGreaterThanOrEqual(1);
    expect(tracer.forStage("orchestrate")).toHaveLength(1);
  });

  it("默认策略 always：单类别也走专家节点（行为不变）", async () => {
    const tracer = new Tracer();
    const api = await createGraph({
      vectorStore: vectorStore(),
      reranker: null,
      llms: { simple: stagedModel(), small: stagedModel(), large: stagedModel() },
      tracer,
      checkpointer: new MemorySaver(),
    });

    for await (const _event of api.streamTokens(
      admittedInput({ ...INPUT, threadId: "t96-always" }),
      { configurable: { thread_id: "t96-always" } },
      { mode: "chunked" },
    )) {
      void _event;
    }

    expect(tracer.forStage("specialist")).toHaveLength(1);
  });
});
