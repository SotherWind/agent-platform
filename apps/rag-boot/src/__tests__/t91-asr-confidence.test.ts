// T9.1 渠道适配层的 ASR 转写置信度 → T2.4 整体置信度
//
// 清单 T9.1 实现要点：「ASR 渠道额外带转写置信度，低置信转写应影响 T2.4 的整体置信度」。
//
// 这一条之前只有 adjustForTranscriptConfidence 函数、没有接线，所以写了也不会生效。
// 本文件把「渠道 → 入参 → 状态 → 置信度 → 转人工」整条链接起来测。
import { MemorySaver } from "@langchain/langgraph";
import { buildGraph } from "../agent";
import { createGraph } from "../index";
import { createFakeLlm } from "../llm/fake";
import {
  normalizeInboundMessage,
  toGraphInput,
  transcriptConfidenceOf,
  UnknownChannelError,
} from "../channels";
import { adjustForTranscriptConfidence, computeConfidence } from "../nodes/confidence";
import type { RetrievedChunk } from "../schema";

const chunk = (id: string, score: number): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "tenant-a",
  content: `知识片段 ${id}`,
  score,
  metadata: {},
});

const vectorStore = {
  search: async () => [chunk("c1", 0.95), chunk("c2", 0.9)],
  addDocuments: async () => 0,
  ingestFile: async () => 0,
  deleteByDocumentId: async () => {},
};

function llm() {
  return createFakeLlm({
    byStage: {
      triage: JSON.stringify({
        categories: ["general"],
        urgency: "normal",
        likelyNeedsHuman: false,
        needsRealtimeData: false,
      }),
      rewrite: "改写后的问题",
      specialist: JSON.stringify({ status: "resolved", answer: "专家回答" }),
      generate: "这是可核对的回答。",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

describe("ASR 转写置信度", () => {
  it("低转写置信度按比例拉低整体置信度，高转写置信度不惩罚", () => {
    const base = computeConfidence([{ ...chunk("c1", 0.95), rerankScore: 0.95 }]).score;

    // 完全没听清 → 置信度归零，必须走低置信兜底
    expect(adjustForTranscriptConfidence(base, 0)).toBe(0);
    // 听清一半 → 按比例折半
    expect(adjustForTranscriptConfidence(base, 0.5)).toBeCloseTo(base * 0.5);
    // 转写完美 → 不惩罚
    expect(adjustForTranscriptConfidence(base, 1)).toBeCloseTo(base);
    // 非 ASR 渠道（null）→ 完全不参与计算，不能用 1.0 兜底假装完美
    expect(adjustForTranscriptConfidence(base, null)).toBe(base);
    expect(adjustForTranscriptConfidence(base, undefined)).toBe(base);
  });

  it("渠道层从语音附件提取转写置信度，多条取最低", () => {
    const asr = normalizeInboundMessage(
      "phone_asr",
      {
        messageId: "call-1",
        transcript: "我要查订单",
        attachments: [
          { type: "audio", transcript: "我要查订单", transcriptConfidence: 0.92 },
          { type: "audio", transcript: "就是那个", transcriptConfidence: 0.31 },
        ],
      },
      { tenantId: "tenant-a", principal: "user-a" },
    );
    expect(transcriptConfidenceOf(asr)).toBe(0.31);

    // 网页渠道没有语音附件 → null，不是 0（0 会把置信度打到 0）
    const web = normalizeInboundMessage(
      "web",
      { messageId: "m-1", content: "查订单" },
      { tenantId: "tenant-a", principal: "user-a" },
    );
    expect(transcriptConfidenceOf(web)).toBeNull();
    expect(toGraphInput(web).transcriptConfidence).toBeNull();
    expect(toGraphInput(asr).transcriptConfidence).toBe(0.31);
  });

  it("主图按 ASR 入参计算置信度，低置信时答案带不确定表述", async () => {
    const model = llm();
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore,
      reranker: {
        rerank: async (_query, chunks) =>
          chunks.map((item) => ({ ...item, rerankScore: 0.95 })),
      },
      llms: { simple: model, small: model, large: model },
    });

    // 转写置信度 0.2：检索很准，但问题本身没听清
    const garbled = await graph.invoke(
      {
        query: "那个什么…",
        tenantId: "tenant-a",
        threadId: "asr-low",
        messages: [],
        transcriptConfidence: 0.2,
      },
      { configurable: { thread_id: "asr-low" } },
    );
    expect(garbled.lowConfidence).toBe(true);
    expect(garbled.asrTranscriptConfidence).toBe(0.2);
    // 低置信路径与高置信路径行为必须可区分（T2.4 验收）
    expect(garbled.finalAnswer).toContain("可能不够完整");
    expect(garbled.degradations.some((d) => d.startsWith("asr_transcript_confidence:"))).toBe(true);

    // 同样的检索结果，转写置信度 0.95 → 正常作答
    const clear = await graph.invoke(
      {
        query: "订单什么时候发货",
        tenantId: "tenant-a",
        threadId: "asr-high",
        messages: [],
        transcriptConfidence: 0.95,
      },
      { configurable: { thread_id: "asr-high" } },
    );
    expect(clear.lowConfidence).toBe(false);
    expect(clear.finalAnswer).not.toContain("可能不够完整");
    expect(clear.confidence!).toBeGreaterThan(garbled.confidence!);
  });

  it("非 ASR 渠道不受影响，且低转写置信度不跨轮残留", async () => {
    const model = llm();
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore,
      reranker: {
        rerank: async (_query, chunks) =>
          chunks.map((item) => ({ ...item, rerankScore: 0.95 })),
      },
      llms: { simple: model, small: model, large: model },
    });
    const config = { configurable: { thread_id: "asr-multi" } };

    // 第一轮：ASR，低转写置信度
    const first = await graph.invoke(
      { query: "含糊的语音", tenantId: "tenant-a", threadId: "asr-multi", messages: [], transcriptConfidence: 0.2 },
      config,
    );
    expect(first.asrTranscriptConfidence).toBe(0.2);
    expect(first.lowConfidence).toBe(true);

    // 第二轮：用户改用文字追问，不带转写置信度
    const second = await graph.invoke(
      { query: "我再补充一下，订单号是 A-100", tenantId: "tenant-a", threadId: "asr-multi", messages: [] },
      config,
    );
    // 关键：上一通电话的低置信不能泄漏到这一轮
    expect(second.asrTranscriptConfidence).toBeNull();
    expect(second.lowConfidence).toBe(false);
  });

  it("连续两轮低转写置信度触发转人工（与 T5.1 联动）", async () => {
    const model = llm();
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore,
      reranker: {
        rerank: async (_query, chunks) =>
          chunks.map((item) => ({ ...item, rerankScore: 0.95 })),
      },
      llms: { simple: model, small: model, large: model },
    });
    const config = { configurable: { thread_id: "asr-escalate" } };

    await graph.invoke(
      { query: "含糊一", tenantId: "tenant-a", threadId: "asr-escalate", messages: [], transcriptConfidence: 0.1 },
      config,
    );
    const second = await graph.invoke(
      { query: "含糊二", tenantId: "tenant-a", threadId: "asr-escalate", messages: [], transcriptConfidence: 0.1 },
      config,
    );

    expect(second.consecutiveLowConfidenceTurns).toBe(2);
    expect(second.route).toBe("escalate");
    expect(second.ticketId).toBeTruthy();
    expect(second.finalAnswer).toContain("人工");
  });

  it("公开入口透传转写置信度，且仍要求鉴权身份", async () => {
    const api = await createGraph({ vectorStore, reranker: null, llms: {} });
    await expect(
      api.invoke({ query: "hi", tenantId: "t", authenticated: false, transcriptConfidence: 0.2, history: [] }),
    ).rejects.toThrow();
  });

  it("未知渠道拒绝而非按默认渠道处理", () => {
    expect(() =>
      normalizeInboundMessage("carrier_pigeon", { id: "x" }, { tenantId: "t", principal: "p" }),
    ).toThrow(UnknownChannelError);
  });
});
