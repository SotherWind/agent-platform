/**
 * T5.1 转人工触发条件
 *
 * 依据中文材料的具体触发条件 + Diffco 的分诊门控。
 * （「用户明确要求转人工」与「连续两轮低置信」分别已在
 *  security.test.ts 与 t91-asr-confidence.test.ts 覆盖，此处补齐其余触发条件。）
 */
import { evaluateEscalation, isHumanRequest } from "../escalation";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";

describe("转人工触发", () => {
  it("连续两次触发兜底话术时自动转人工", () => {
    const decision = evaluateEscalation({ consecutiveFallbackTurns: 2 });
    expect(decision.required).toBe(true);
    expect(decision.triggers).toContain("repeated_fallback");
    // 只有一次兜底不触发（阈值就是 2）
    expect(evaluateEscalation({ consecutiveFallbackTurns: 1 }).required).toBe(false);
  });

  it("情绪判定为极度负面时触发", () => {
    const decision = evaluateEscalation({ sentiment: "negative", sentimentIntensity: 0.9 });
    expect(decision.required).toBe(true);
    expect(decision.triggers).toContain("negative_sentiment");
    expect(decision.reasons.join()).toContain("极度负面");

    // 负面但强度不够不算「极度」
    expect(
      evaluateEscalation({ sentiment: "negative", sentimentIntensity: 0.5 }).required,
    ).toBe(false);
    // 阈值可配置
    expect(
      evaluateEscalation(
        { sentiment: "negative", sentimentIntensity: 0.5 },
        { sentimentIntensityThreshold: 0.4 },
      ).triggers,
    ).toContain("negative_sentiment");
  });

  it("Reviewer 连续不通过时触发", () => {
    const decision = evaluateEscalation({ consecutiveReviewFailures: 2 });
    expect(decision.required).toBe(true);
    expect(decision.triggers).toContain("reviewer_rejected");
    expect(evaluateEscalation({ consecutiveReviewFailures: 1 }).required).toBe(false);
  });

  it("triage 判定 likelyNeedsHuman 时不进专家节点直接触发", async () => {
    // 输入不命中 prefilter 的「转人工」规则（那条由 T9.3 前置层处理），
    // 由 triage 模型判定 likelyNeedsHuman —— 验证分诊门控本身。
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({
          categories: ["general"],
          urgency: "normal",
          likelyNeedsHuman: true,
          needsRealtimeData: false,
        }),
      },
    });
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
      { query: "这个问题折腾我三天了还没解决", tenantId: "t", threadId: "t51-triage", messages: [] },
      { configurable: { thread_id: "t51-triage" } },
    );

    // 不进专家节点
    expect(model.callsFor("specialist")).toHaveLength(0);
    // 直接触发转人工 + 建单
    expect(result.escalation?.required).toBe(true);
    expect(result.escalation?.triggers).toContain("triage_likely_needs_human");
    expect(result.ticketId).toBeTruthy();
    // 交接包一并生成（T5.2 与 T5.1 的衔接点）
    expect(result.handoff).not.toBeNull();
  });

  it("用户明确要求转人工时规则前置命中，不经模型", () => {
    // 规则层（isHumanRequest）覆盖中文材料中的主要表述
    expect(isHumanRequest("转人工")).toBe(true);
    expect(isHumanRequest("帮我接人工客服")).toBe(true);
    expect(isHumanRequest("我要投诉你们")).toBe(true);
    expect(isHumanRequest("找个真人来聊聊")).toBe(true);
    // 正常问题不误命中
    expect(isHumanRequest("退款规则是什么")).toBe(false);

    // 策略层：user_request 立即触发
    const decision = evaluateEscalation({ userAskedForHuman: true });
    expect(decision.required).toBe(true);
    expect(decision.triggers).toContain("user_request");
  });
});
