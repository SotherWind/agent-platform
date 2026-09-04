/**
 * T5.1 情绪触发链路
 *
 * 背景：evaluateEscalation 一直支持 negative_sentiment 分支（t51-escalation.test.ts 覆盖），
 * 但直到补这一组测试前，全链路有两处断点，使该分支是死代码：
 *   1. 没有任何地方计算 sentiment —— escalateNode 从不传这两个字段；
 *   2. routeAfterReview 的 escalate 条件不看情绪 —— 即使算出来也走不到 humanEscalation。
 * 因此这里既测 scoreSentiment 的打分，也跑真实图验证「端到端真的会转人工」。
 */
import { describe, expect, it } from "vitest";
import { scoreSentiment } from "../sentiment";
import { DEFAULT_SENTIMENT_INTENSITY_THRESHOLD } from "../escalation";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import type { RetrievedChunk } from "../schema";

const doc = (id: string, tenantId = "tenant-a"): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId,
  content: `知识片段 ${id}`,
  score: 0.9,
  metadata: {},
});

/** 检索有结果 + 终审通过，确保升级只能来自情绪，不会被空检索兜底污染断言 */
function build() {
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
        answer: "请参考知识库中的退款规则。",
        citations: ["c1"],
      }),
      generate: "基于知识库，这是可核对的回答。",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });

  return buildGraph({
    vectorStore: {
      search: async () => [doc("c1")],
      addDocuments: async () => 1,
      ingestFile: async () => 1,
      deleteByDocumentId: async () => {},
    },
    reranker: null,
    llms: { simple: model, small: model, large: model },
  });
}

describe("T5.1 情绪打分（scoreSentiment）", () => {
  it("平静咨询判为 neutral，不惊动人工", () => {
    const score = scoreSentiment("请问退款规则是什么？");
    expect(score.sentiment).toBe("neutral");
    expect(score.intensity).toBeLessThan(DEFAULT_SENTIMENT_INTENSITY_THRESHOLD);
  });

  it("轻度不满判为负面，但强度不足以触发转人工", () => {
    const score = scoreSentiment("我很失望，这个问题一直没人管！");
    expect(score.sentiment).toBe("negative");
    // 不满 ≠ 极度负面：一有情绪就转人工会把人工坐席淹掉
    expect(score.intensity).toBeLessThan(DEFAULT_SENTIMENT_INTENSITY_THRESHOLD);
  });

  it("辱骂叠加投诉升级判为极度负面", () => {
    const score = scoreSentiment("你们这个垃圾产品！我要投诉到消协！这已经是第三次了！");
    expect(score.sentiment).toBe("negative");
    expect(score.intensity).toBeGreaterThanOrEqual(DEFAULT_SENTIMENT_INTENSITY_THRESHOLD);
  });

  it("致谢类输入判为 positive", () => {
    const score = scoreSentiment("谢谢，问题已经解决了，很满意");
    expect(score.sentiment).toBe("positive");
  });

  it("空输入不崩且判为 neutral", () => {
    expect(scoreSentiment("")).toEqual({ sentiment: "neutral", intensity: 0 });
  });
});

describe("T5.1 情绪触发端到端（真实图）", () => {
  it("极度负面输入在图内触发 negative_sentiment 并转人工", async () => {
    const graph = await build();
    // 刻意避开 HUMAN_REQUEST_PATTERNS（/我要投诉/ 等会命中 prefilter 的
    // human_request 分支，那样验证的是既有的人工请求路径，而非情绪路由）。
    const result = await graph.invoke(
      {
        query: "这破服务简直是欺诈！垃圾一样的质量！忍无可忍！！！",
        tenantId: "tenant-a",
        threadId: "thread-angry",
        messages: [],
      },
      { configurable: { thread_id: "thread-angry" } },
    );

    // turnStart 真的算了情绪（此前这两个字段永远是默认值）
    expect(result.sentiment).toBe("negative");
    expect(result.sentimentIntensity).toBeGreaterThanOrEqual(DEFAULT_SENTIMENT_INTENSITY_THRESHOLD);
    // 路由真的走到了 humanEscalation（此前路由不看情绪，走到这里才会落 decision）
    expect(result.escalation?.required).toBe(true);
    expect(result.escalation?.triggers).toContain("negative_sentiment");
  });

  it("平静输入不会因情绪升级", async () => {
    const graph = await build();
    const result = await graph.invoke(
      {
        query: "请问退款规则是什么？",
        tenantId: "tenant-a",
        threadId: "thread-calm",
        messages: [],
      },
      { configurable: { thread_id: "thread-calm" } },
    );

    expect(result.sentiment).toBe("neutral");
    expect(result.escalation).toBeNull();
    expect(result.finalAnswer).toContain("可核对");
  });
});
