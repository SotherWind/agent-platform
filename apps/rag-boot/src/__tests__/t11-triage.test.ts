/**
 * T1.1 分诊节点（Triage）
 *
 * 依据 Diffco 阶段 2：小模型一次调用，多标签分类 + 紧急度 + 是否需人工，
 * 严格 JSON schema，门控下游。
 *
 * 验收（清单 215 行）：
 * - 非法输出必然降级而非崩溃
 * - 规则命中路径不消耗 token
 */
import { triage, conservativeTriage, DEFAULT_HIGH_URGENCY_PATTERNS } from "../nodes/triage";
import { TriageResultSchema } from "../schema";
import { createFakeLlm } from "../llm/fake";
import { buildGraph } from "../agent";
import type { FakeLlm } from "../llm/fake";

const VALID_TRIAGE = JSON.stringify({
  categories: ["billing"],
  urgency: "normal",
  likelyNeedsHuman: false,
  needsRealtimeData: false,
});

/** 主图全阶段可用的 fake LLM；triage 回复可覆盖 */
function fullLlm(triageReply: string): FakeLlm {
  return createFakeLlm({
    byStage: {
      triage: triageReply,
      rewrite: "退款规则",
      specialist: JSON.stringify({ status: "resolved", answer: "按知识库回答。", citations: ["c1"] }),
      generate: "基于知识库的回答。",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

describe("triageNode", () => {
  it("输出符合 TriageResultSchema 的严格 JSON", async () => {
    const llm = createFakeLlm({ reply: VALID_TRIAGE });
    const result = await triage({ query: "账单有问题", history: [] }, { llm });

    // TriageResultSchema.parse 不抛错 = 严格 schema 校验通过
    expect(() => TriageResultSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      categories: ["billing"],
      urgency: "normal",
      likelyNeedsHuman: false,
      needsRealtimeData: false,
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("识别多标签意图（账单 + 集成）而非二选一", async () => {
    const llm = createFakeLlm({
      reply: JSON.stringify({
        categories: ["billing", "integration"],
        urgency: "normal",
        likelyNeedsHuman: false,
        needsRealtimeData: false,
      }),
    });
    const result = await triage({ query: "账单金额对不上，而且集成也不同步了", history: [] }, { llm });

    expect(result.categories).toEqual(expect.arrayContaining(["billing", "integration"]));
    expect(result.categories).toHaveLength(2);
  });

  it("likelyNeedsHuman 为 true 时直接路由到 escalate，不进专家节点", async () => {
    const model = fullLlm(
      JSON.stringify({
        categories: ["general"],
        urgency: "normal",
        likelyNeedsHuman: true,
        needsRealtimeData: false,
      }),
    );
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

    const result = await graph.invoke(
      { query: "这个问题我忍很久了", tenantId: "tenant-a", threadId: "t11-human", messages: [] },
      { configurable: { thread_id: "t11-human" } },
    );

    // 不进专家节点：specialist 阶段零调用
    expect(model.callsFor("specialist")).toHaveLength(0);
    expect(result.route).toBe("escalate");
    expect(result.escalation?.triggers).toContain("triage_likely_needs_human");
    expect(result.ticketId).toBeTruthy();
  });

  it("高紧急度直接进人工队列", async () => {
    // 规则前置路径：不传 LLM，命中 DEFAULT_HIGH_URGENCY_PATTERNS
    const result = await triage(
      { query: "账号被锁了，生产环境登录不进去", history: [] },
      {}, // 无 llm：只走规则
    );

    expect(result.urgency).toBe("high");
    expect(result.likelyNeedsHuman).toBe(true);
    // 规则路径不消耗 token：没有任何模型调用发生（无 llm 可调）
    expect(DEFAULT_HIGH_URGENCY_PATTERNS.some((r) => r.test("账号被锁了，生产环境登录不进去"))).toBe(true);
  });

  it("LLM 返回非法 JSON 时按保守策略降级为转人工", async () => {
    const llm = createFakeLlm({ reply: "这不是 JSON，模型胡言乱语了" });
    const result = await triage({ query: "随便问一句", history: [] }, { llm });

    // 保守降级 = 需要人工，绝不猜一个分类继续走
    expect(result).toEqual(conservativeTriage());
    expect(result.likelyNeedsHuman).toBe(true);
    expect(result.source).toBe("fallback");
  });
});
