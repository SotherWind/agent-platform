/**
 * T9.5 真流式（streamTokens）——分段缓冲审查 + 对账替换
 *
 * 三种模式的语义钉子：
 * - chunked：delta 按句子边界分段、concat == finalAnswer（终审通过路径）；
 *   终审拒绝 → replace(content_revised)，最终答案 = 升级话术；
 *   预检拦截 → held + replace(segment_blocked)，被拦内容绝不回传。
 * - strict ：等价原 stream() 的事件化（24 字块，concat == finalAnswer）。
 * - async  ：token 零缓冲直出，concat == finalAnswer。
 */
import { createGraph } from "../index";
import { admittedInput } from "./helpers/admitted-input";
import { createFakeLlm } from "../llm/fake";
import { SEGMENT_BLOCKED_REPLY, type StreamEvent } from "../stream-review";
import type { RetrievedChunk } from "../schema";
import { ActionGuardrails } from "../guardrails/action";
import { ActionSignalBus } from "../actions/signal";
import { ProposalService } from "../actions/proposal";
import { createRefundTool, FakeBackend } from "../tools/business";

const PASSING_REVIEW = JSON.stringify({ passed: true, violations: [] });
const FAILING_REVIEW = JSON.stringify({
  passed: false,
  violations: [{ code: "overpromise", detail: "虚假承诺表述" }],
});

function stagedModel(draft: string, review: string = PASSING_REVIEW) {
  return createFakeLlm({
    byStage: {
      triage: JSON.stringify({
        categories: ["general"],
        urgency: "normal",
        likelyNeedsHuman: false,
        needsRealtimeData: false,
      }),
      specialist: JSON.stringify({ status: "resolved", answer: draft }),
      generate: draft,
      review,
    },
  });
}

const doc = (id: string): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "tenant-a",
  content: `知识片段 ${id}`,
  score: 0.9,
  metadata: {},
});

function vectorStoreReturning() {
  return {
    search: async () => [doc("c1")],
    addDocuments: async () => 1,
    ingestFile: async () => 1,
    deleteByDocumentId: async () => {},
  };
}

async function collect(
  events: AsyncGenerator<StreamEvent>,
): Promise<{ deltas: string[]; all: StreamEvent[] }> {
  const deltas: string[] = [];
  const all: StreamEvent[] = [];
  for await (const event of events) {
    all.push(event);
    if (event.type === "delta") deltas.push(event.text);
  }
  return { deltas, all };
}

const INPUT = {
  query: "退款规则",
  tenantId: "tenant-a",
  authenticated: true,
  threadId: "t95",
  history: [] as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
};

describe("T9.5 真流式 streamTokens", () => {
  it("chunked：按句子边界分段流出，拼接等于 finalAnswer，终审通过时无 replace", async () => {
    const draft = "退款时效取决于支付方式。微信与支付宝为 1-3 个工作日。银行卡为 3-7 个工作日。";
    const api = await createGraph({
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: stagedModel(draft), small: stagedModel(draft), large: stagedModel(draft) },
    });

    const { deltas, all } = await collect(
      api.streamTokens(
        admittedInput({ ...INPUT, threadId: "t95-chunked-pass" }),
        { configurable: { thread_id: "t95-chunked-pass" } },
        { mode: "chunked" },
      ),
    );

    const final = all.find((e) => e.type === "final");
    const replaces = all.filter((e) => e.type === "replace");
    // 句子边界分段：不止一段，且每段以句末标点结尾（最后一段为冲刷尾巴）
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(draft);
    expect(replaces).toHaveLength(0);
    // 二期协议：final 携带结构化 citations（与 sources 同源），供前端渲染引用来源
    expect(final).toEqual({
      type: "final",
      answer: draft,
      sources: expect.anything(),
      citations: [{ chunkId: "c1", documentId: "doc-c1", text: "知识片段 c1" }],
    });
  });

  it("chunked：写工具产出确认单 → final 携带 confirmation（proposalId/confirmToken/summary）", async () => {
    const proposalLlm = createFakeLlm({
      byStage: {
        triage: JSON.stringify({
          categories: ["order"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: false,
        }),
        specialist: JSON.stringify({
          status: "needsOrchestrator",
          partialAnswer: "可以申请退款",
          toolRequests: [
            { name: "propose_refund", args: { orderId: "o-1", amountCents: 10, tenantId: "tenant-a" } },
          ],
        }),
        generate: "我可以帮你申请退款",
        review: PASSING_REVIEW,
      },
    });
    const api = await createGraph({
      vectorStore: { search: async () => [], addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {} },
      reranker: null,
      llms: { simple: proposalLlm, small: proposalLlm, large: proposalLlm },
      tools: [createRefundTool(new FakeBackend())],
      proposalService: new ProposalService({ secret: "t95" }),
      signalBus: new ActionSignalBus(),
      actionGuardrails: new ActionGuardrails(),
    });

    const { all } = await collect(
      api.streamTokens(
        admittedInput({ ...INPUT, threadId: "t95-confirm", principal: "user-t95" }),
        { configurable: { thread_id: "t95-confirm" } },
        { mode: "chunked" },
      ),
    );

    const final = all.find((e) => e.type === "final");
    expect(final?.type).toBe("final");
    if (final?.type !== "final") return;
    expect(final.answer).toContain("确认单：");
    expect(final.confirmation).toBeDefined();
    expect(final.confirmation!.action).toBe("propose_refund");
    expect(final.confirmation!.proposalId).toBeTruthy();
    expect(final.confirmation!.confirmToken).toBeTruthy();
    expect(final.confirmation!.expiresAt).toBeGreaterThan(0);
    expect(final.citations).toBeUndefined();
  });

  it("chunked：终审拒绝 → replace(content_revised)，最终答案为升级话术，草稿不作为 final 透出", async () => {
    const draft = "本产品保证百分百满意，绝对没有问题！";
    const api = await createGraph({
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: stagedModel(draft, FAILING_REVIEW), small: stagedModel(draft, FAILING_REVIEW), large: stagedModel(draft, FAILING_REVIEW) },
    });

    const { all } = await collect(
      api.streamTokens(
        admittedInput({ ...INPUT, threadId: "t95-chunked-review-fail" }),
        { configurable: { thread_id: "t95-chunked-review-fail" } },
        { mode: "chunked" },
      ),
    );

    const replace = all.find((e) => e.type === "replace") as
      | { type: "replace"; reason: string; answer: string }
      | undefined;
    const final = all.find((e) => e.type === "final") as { answer: string } | undefined;
    expect(replace).toBeDefined();
    expect(replace!.reason).toBe("content_revised");
    // 最终答案是不含草稿的升级话术
    expect(final!.answer).not.toContain("百分百");
    expect(final!.answer).toContain("人工");
  });

  it("chunked：段级预检拦截 → held + replace(segment_blocked)，被拦内容绝不回传", async () => {
    const draft = "正常的第一句话。这里包含不该出现的内容，第二句话被预检拦下。";
    const api = await createGraph({
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: stagedModel(draft), small: stagedModel(draft), large: stagedModel(draft) },
      segmentPrechecker: (segment) =>
        segment.includes("不该出现") ? { ok: false, reason: "blocked_phrase" } : { ok: true },
    });

    const { deltas, all } = await collect(
      api.streamTokens(
        admittedInput({ ...INPUT, threadId: "t95-chunked-precheck" }),
        { configurable: { thread_id: "t95-chunked-precheck" } },
        { mode: "chunked" },
      ),
    );

    const replaces = all.filter((e) => e.type === "replace") as Array<{ reason: string; answer: string }>;
    const held = all.find((e) => e.type === "held");
    expect(held).toBeDefined();
    expect(replaces).toHaveLength(1);
    expect(replaces[0].reason).toBe("blocked_phrase");
    expect(replaces[0].answer).toBe(SEGMENT_BLOCKED_REPLY);
    // 拦截点之后的任何草稿内容（含被拦段）都不允许出现在已流出文本里
    expect(deltas.join("")).not.toContain("不该出现");
  });

  it("strict：等价原 stream() 的事件化——24 字块、concat == finalAnswer、无 replace", async () => {
    const draft = "这是一段通过终审的完整回答内容，用于验证 strict 模式的事件协议。";
    const api = await createGraph({
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: stagedModel(draft), small: stagedModel(draft), large: stagedModel(draft) },
    });

    const { deltas, all } = await collect(
      api.streamTokens(
        admittedInput({ ...INPUT, threadId: "t95-strict" }),
        { configurable: { thread_id: "t95-strict" } },
        { mode: "strict" },
      ),
    );

    const final = all.find((e) => e.type === "final") as { answer: string } | undefined;
    expect(deltas.join("")).toBe(draft);
    expect(deltas.every((d) => d.length <= 24)).toBe(true);
    expect(all.some((e) => e.type === "replace")).toBe(false);
    expect(final!.answer).toBe(draft);
  });

  it("async：token 零缓冲直出，拼接等于 finalAnswer", async () => {
    const draft = "这是异步模式的开场说明。这是异步模式的收尾说明。";
    const api = await createGraph({
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: stagedModel(draft), small: stagedModel(draft), large: stagedModel(draft) },
    });

    const { deltas, all } = await collect(
      api.streamTokens(
        admittedInput({ ...INPUT, threadId: "t95-async" }),
        { configurable: { thread_id: "t95-async" } },
        { mode: "async" },
      ),
    );

    const final = all.find((e) => e.type === "final") as { answer: string } | undefined;
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(draft);
    expect(all.some((e) => e.type === "replace")).toBe(false);
    expect(final!.answer).toBe(draft);
  });
});
