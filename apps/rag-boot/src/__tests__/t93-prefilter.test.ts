// T9.3 前置拦截与直答
//
// 依据架构图：未命中才进入 LLM 链路，用于控成本与 P95。
//
// 清单 767-769 的验收：
// - ✅ 每条直答路径的 LLM 调用次数断言为 0
// - ✅ 命中率可观测（这是成本优化的主要抓手之一）
import { MemorySaver } from "@langchain/langgraph";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import {
  Prefilter,
  DEFAULT_FAQS,
  DEFAULT_CHITCHAT_REPLY,
  DEFAULT_BLACKLIST_REPLY,
  type FaqEntry,
} from "../prefilter";

const vectorStore = {
  search: async () => [],
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
      generate: "模型生成的回答",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

/** 黑名单：辱骂与广告导流 */
const blacklist = [/傻逼/, /加微信/, /刷单/];

describe("前置拦截与直答", () => {
  it("命中黑名单直接短路，零 LLM 调用", async () => {
    const model = llm();
    const prefilter = new Prefilter({ blacklist });
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore,
      reranker: null,
      llms: { simple: model, small: model, large: model },
      prefilter,
    });

    const result = await graph.invoke(
      { query: "你这个傻逼机器人", tenantId: "t", threadId: "pf-blacklist", messages: [] },
      { configurable: { thread_id: "pf-blacklist" } },
    );

    expect(result.prefilterHit).toBe("blacklist");
    expect(result.finalAnswer).toBe(DEFAULT_BLACKLIST_REPLY);
    // 硬门禁：一条直答路径上模型一次都不能被调用
    expect(model.calls).toHaveLength(0);
    expect(result.budget.llmCalls).toBe(0);
  });

  it("高频 FAQ 精确命中时直答，不走检索与生成", async () => {
    const model = llm();
    let searchCalls = 0;
    const graph = await buildGraph({
      vectorStore: {
        ...vectorStore,
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      reranker: null,
      llms: { simple: model, small: model, large: model },
      prefilter: new Prefilter(),
    });

    const result = await graph.invoke(
      { query: "怎么开发票？", tenantId: "t", threadId: "pf-faq", messages: [] },
      { configurable: { thread_id: "pf-faq" } },
    );

    expect(result.prefilterHit).toBe("faq");
    expect(result.directAnswer).toBe(DEFAULT_FAQS[0].answer);
    expect(result.finalAnswer).toBe(DEFAULT_FAQS[0].answer);
    // 直答路径既不检索也不生成
    expect(searchCalls).toBe(0);
    expect(model.callsFor("generate")).toHaveLength(0);
    expect(model.callsFor("triage")).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it("闲聊类输入走固定兜底话术，不消耗主模型", async () => {
    const model = llm();
    const graph = await buildGraph({
      vectorStore,
      reranker: null,
      llms: { simple: model, small: model, large: model },
      prefilter: new Prefilter(),
    });

    const result = await graph.invoke(
      { query: "你好", tenantId: "t", threadId: "pf-chitchat", messages: [] },
      { configurable: { thread_id: "pf-chitchat" } },
    );

    expect(result.prefilterHit).toBe("chitchat");
    expect(result.finalAnswer).toBe(DEFAULT_CHITCHAT_REPLY);
    expect(model.calls).toHaveLength(0);
  });

  it("明确指令（转人工）直接路由，不经过 triage 模型", async () => {
    const model = llm();
    const graph = await buildGraph({
      vectorStore,
      reranker: null,
      llms: { simple: model, small: model, large: model },
      prefilter: new Prefilter(),
    });

    const result = await graph.invoke(
      { query: "转人工", tenantId: "t", threadId: "pf-human", messages: [] },
      { configurable: { thread_id: "pf-human" } },
    );

    expect(result.prefilterHit).toBe("human_request");
    // 直接进人工队列：分诊模型一次都没跑，且真的建了工单
    expect(model.callsFor("triage")).toHaveLength(0);
    expect(result.route).toBe("escalate");
    expect(result.ticketId).toBeTruthy();
    expect(result.finalAnswer).toContain("人工");
  });

  it("未命中任何规则时正常进入 LLM 链路", async () => {
    const model = llm();
    const graph = await buildGraph({
      vectorStore,
      reranker: null,
      llms: { simple: model, small: model, large: model },
      prefilter: new Prefilter({ blacklist }),
    });

    const result = await graph.invoke(
      { query: "我的订单为什么还没发货", tenantId: "t", threadId: "pf-miss", messages: [] },
      { configurable: { thread_id: "pf-miss" } },
    );

    expect(result.prefilterHit).toBeNull();
    expect(model.callsFor("triage")).toHaveLength(1);
    expect(result.budget.llmCalls).toBeGreaterThan(0);
  });

  it("直答命中率与节省的 token 数可观测", () => {
    const prefilter = new Prefilter({ blacklist });

    expect(prefilter.metrics().hitRate).toBe(0);
    prefilter.run("你好");
    prefilter.run("怎么开发票？");
    prefilter.run("你这个傻逼");
    prefilter.run("转人工");
    prefilter.run("我的订单为什么还没发货", { tenantId: "t" });

    const metrics = prefilter.metrics();
    expect(metrics.total).toBe(5);
    expect(metrics.hits).toBe(4);
    expect(metrics.hitRate).toBeCloseTo(0.8);
    expect(metrics.byType).toEqual({
      chitchat: 1,
      faq: 1,
      blacklist: 1,
      human_request: 1,
    });
    // 直答省下的是「本来要花的上下文 + 生成预算」，必须能算出来
    expect(metrics.savedTokens).toBeGreaterThan(0);
  });

  it("FAQ 按租户隔离，空输入放行而不是误命中", () => {
    const tenantFaq: FaqEntry = {
      id: "faq-tenant-b-only",
      patterns: [/内部流程/],
      answer: "B 租户专属答案",
      tenantId: "tenant-b",
    };
    const prefilter = new Prefilter({ faqs: [tenantFaq] });

    const fromA = prefilter.run("内部流程是什么", { tenantId: "tenant-a" });
    expect(fromA.hit).toBeNull();
    expect(fromA.action).toBe("continue");

    const fromB = prefilter.run("内部流程是什么", { tenantId: "tenant-b" });
    expect(fromB.hit).toBe("faq");
    expect(fromB.answer).toBe("B 租户专属答案");

    // 空输入：放行给后续链路处理，不在这里瞎猜
    const empty = prefilter.run("   ");
    expect(empty.action).toBe("continue");
    expect(empty.savedTokens).toBe(0);
  });
});
