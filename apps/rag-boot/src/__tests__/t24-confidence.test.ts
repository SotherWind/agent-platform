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
import { ConfidenceProfileSchema } from "../confidence/profile";
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

  it("群像式幻觉：一簇勉强相关的 chunk 不得放行", () => {
    // 场景：用户问「退货政策是什么」，知识库里根本没有这条。
    // 召回 10 条全在 0.30 上下晃，其中一条刚好蹭过 0.35。
    // 旧实现把 coverage 定义成「达到最高分 60% 的占比」，于是这 10 条互相"接近"，
    // coverage = 100%，score = 1.0，闸门放行 —— 模型拿着一堆勉强相关的 chunk 编答案。
    const flock = [
      chunk("c1", 0.36), chunk("c2", 0.32), chunk("c3", 0.31), chunk("c4", 0.31),
      chunk("c5", 0.3), chunk("c6", 0.3), chunk("c7", 0.3), chunk("c8", 0.3),
      chunk("c9", 0.3), chunk("c10", 0.3),
    ];
    const result = computeConfidence(flock);

    expect(result.topScore).toBeCloseTo(0.36, 4);
    // 绝对口径：只有 1 条真的过 floor 线，不是 80% / 100%
    expect(result.coverage).toBeCloseTo(0.1, 4);
    expect(result.supportCount).toBe(1);
    expect(result.lowConfidence).toBe(true);
    // 群像被单独命名，而不是混进 lowConfidence 里看不见
    expect(result.flockHallucination).toBe(true);
    // 合成分数必须真的能掉到阈值以下——旧公式恒定 >= 0.7，score < threshold 是死代码
    expect(result.score).toBeLessThan(0.35);
  });

  it("群像式幻觉：整簇都略高于 floor 但互相没有区分度，同样拦下", () => {
    // 这是上一条的更刁钻版本：coverage 真的是 100%（每条都过线），
    // 光靠绝对覆盖度挡不住，必须靠「区分度」这条判据。
    const flat = [0.36, 0.36, 0.35, 0.35, 0.35, 0.35].map((s, i) => chunk(`f${i}`, s));
    const result = computeConfidence(flat);

    expect(result.coverage).toBeCloseTo(1, 4);
    expect(result.discrimination).toBeLessThan(0.5);
    expect(result.corroborated).toBe(false);
    expect(result.lowConfidence).toBe(true);
    expect(result.flockHallucination).toBe(true);
  });

  it("两条都刚过线也不算有支撑（旁证至少两条且要有区分度）", () => {
    // 0.36 / 0.35：占比 100%，但落差只有 0.01，等于两条在同一个噪声带上
    const result = computeConfidence([chunk("a", 0.36), chunk("b", 0.35)]);
    expect(result.corroborated).toBe(false);
    expect(result.lowConfidence).toBe(true);
  });

  it("单条中等分不因『相对归一』被洗成高置信", () => {
    // 旧实现里单条 0.40 会被 min-max 归一成满分 1.0、coverage 也是 1.0
    const result = computeConfidence([chunk("x", 0.4)]);
    expect(result.lowConfidence).toBe(true);
    expect(result.score).toBeLessThan(0.35);
  });

  it("真·多条支撑仍判高置信——闸门不能收成一律转人工", () => {
    // 反向保护：一条强命中（过实心线）+ 一条次强，属于真的答得出来
    const strong = computeConfidence([
      chunk("a", 0.62), chunk("b", 0.58), chunk("c", 0.41), chunk("d", 0.12),
    ]);
    expect(strong.lowConfidence).toBe(false);

    // 一条非常强的命中不需要旁证——旧实现用相对 coverage 扣了它的分
    const lone = computeConfidence([chunk("s", 0.91), chunk("n1", 0.1), chunk("n2", 0.08)]);
    expect(lone.topScore).toBeCloseTo(0.91, 4);
    expect(lone.coverage).toBeCloseTo(1 / 3, 4);
    expect(lone.lowConfidence).toBe(false);
    expect(lone.score).toBeCloseTo(0.91, 4);
  });

  it("合成分数不是装饰性的：存在 score < threshold 的真实场景", () => {
    // 回归旧的「分数下界」缺陷：归一化 topScore × 0.7 + coverage × 0.3 的值域是 [0.7, 1]，
    // 所以 `score < threshold`（0.35）永远为假。这里断言它必须能真的落下去。
    const result = computeConfidence([chunk("a", 0.36), chunk("b", 0.0001)]);
    expect(result.score).toBeLessThan(0.35);
    expect(result.lowConfidence).toBe(true);
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

  it("群像式幻觉在图里被拦住，标记进 state / degradations / tracing", async () => {
    const model = fullLlm();
    const tracer = new Tracer();
    const flock = [0.36, 0.32, 0.31, 0.31, 0.3, 0.3].map((s, i) => chunk(`g${i}`, s));
    const graph = await buildGraph({
      tracer,
      vectorStore: {
        search: async () => flock,
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
      // 刻意不传 confidenceProfile：验证"未标定"这件事会被如实标出来
    });

    const result = await graph.invoke(
      { query: "退货政策是什么", tenantId: "t", threadId: "t24-flock", messages: [] },
      { configurable: { thread_id: "t24-flock" } },
    );

    expect(result.lowConfidence).toBe(true);
    expect(result.finalAnswer).toContain("可能不够完整");
    // 群像被单独命名，可统计可告警
    expect(result.confidenceDiagnostics?.flockHallucination).toBe(true);
    expect(result.degradations.some((d) => d.includes("flock_hallucination"))).toBe(true);
    // 绝对口径的覆盖度写进了 state（只有一条过 floor 线）
    expect(result.confidenceDiagnostics?.supportCount).toBe(1);

    // 阈值出处可观测：没传 profile 时必须显式标 uncalibrated，不允许看起来像标定产物
    const spans = tracer.forTrace(result.traceId);
    const span = spans.find((s) => s.attributes.confidenceProfile !== undefined);
    expect(span).toBeDefined();
    expect(String(span?.attributes.confidenceProfile)).toContain("uncalibrated");
    expect(span?.attributes.flockHallucination).toBe(true);

    // 连续两轮低置信 → 转人工，且交接包必须带上"低置信的原因"
    const second = await graph.invoke(
      { query: "那帮我查一下退货政策", tenantId: "t", threadId: "t24-flock", messages: [] },
      { configurable: { thread_id: "t24-flock" } },
    );
    expect(second.route).toBe("escalate");
    expect(second.handoff?.confidenceDiagnostics?.flockHallucination).toBe(true);
    expect(second.handoff?.confidenceDiagnostics?.profile).toContain("uncalibrated");
    expect(second.handoff?.confidenceDiagnostics?.supportCount).toBe(1);
  });

  it("群像场景里模型编造的具体承诺不会进入用户话术，但保留给人工编辑", async () => {
    // 低置信只做两件事：套不确定表述 + 两轮后转人工。它**不移除**编造内容。
    // 真正把编造拦在用户之外的是输出侧 grounding（deterministic 检查）。
    // 这里端到端钉住：编造的百分比不出现在 finalAnswer，但草稿完整进交接包。
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({
          categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false,
        }),
        specialist: JSON.stringify({ status: "resolved", answer: "可用性说明" }),
        generate: "我们承诺 99.99% 的可用性。",
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });
    const flock = [0.36, 0.32, 0.31, 0.31, 0.3].map((s, i) => chunk(`h${i}`, s));
    const graph = await buildGraph({
      vectorStore: {
        search: async () => flock,
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
    });

    const result = await graph.invoke(
      { query: "你们的 SLA 承诺是几个 9？", tenantId: "t", threadId: "t24-grounding", messages: [] },
      { configurable: { thread_id: "t24-grounding" } },
    );

    expect(result.lowConfidence).toBe(true);
    // 编造内容被 grounding 拦下 → 不走"答案 + 转人工"，而是纯安全话术
    expect(result.route).toBe("escalate");
    expect(result.finalAnswer).not.toContain("99.99");
    // 终审不通过映射为 policy_violation（reviewer_rejected 专指"连续两轮终审失败"，
    // 语义不同，别混用）
    expect(result.escalation?.triggers).toContain("policy_violation");
    // 但草稿不丢：人工是在编辑而不是从零写（T5.2）
    expect(result.handoff?.draftReply).toContain("99.99");
  });

  it("标定 profile 生效时，阈值与出处一起进 tracing", async () => {
    const model = fullLlm();
    const tracer = new Tracer();
    const graph = await buildGraph({
      tracer,
      vectorStore: {
        search: async () => [chunk("c1", 0.5)],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
      confidenceProfiles: [
        ConfidenceProfileSchema.parse({
          floor: 0.42,
          solid: 0.71,
          profileVersion: "Qwen3-Reranker-8B-kb-2026-03-商品咨询-v1",
          rerankerModel: "Qwen3-Reranker-8B",
          kbVersion: "kb-2026-03",
          domain: "商品咨询",
          calibrated: true,
          provenance: "measured",
          calibratedAt: "2026-03-01T00:00:00.000Z",
          sampleSize: 240,
        }),
      ],
      confidenceContext: {
        rerankerModel: "Qwen3-Reranker-8B",
        kbVersion: "kb-2026-03",
        domain: "商品咨询",
      },
    });

    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t24-profile", messages: [] },
      { configurable: { thread_id: "t24-profile" } },
    );

    // floor 抬到 0.42 后，同一个 0.5 的分数不再是"必然高置信"，而是中间地带
    expect(result.confidenceDiagnostics?.threshold).toBe(0.42);
    expect(result.confidenceDiagnostics?.solid).toBe(0.71);
    expect(result.confidenceDiagnostics?.profile).toBe("exact/measured");
    expect(result.confidenceDiagnostics?.stale).toBe(false);
    expect(result.confidenceDiagnostics?.provisional).toBe(false);

    const spans = tracer.forTrace(result.traceId);
    const span = spans.find((s) => s.attributes.confidenceProfile !== undefined);
    expect(String(span?.attributes.confidenceProfile)).toBe("exact/measured");
    expect(span?.attributes.confidenceProfileStale).toBe(false);
  });

  it("换 reranker 后没重标：沿用旧 profile 但 stale 标记必须浮现", async () => {
    const model = fullLlm();
    const graph = await buildGraph({
      vectorStore: {
        search: async () => [chunk("c1", 0.8)],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model, small: model, large: model },
      confidenceProfiles: [
        ConfidenceProfileSchema.parse({
          profileVersion: "old-v1",
          rerankerModel: "Qwen3-Reranker-8B",
          kbVersion: "kb-2026-03",
          domain: "商品咨询",
          calibrated: true,
          provenance: "measured",
          calibratedAt: "2026-03-01T00:00:00.000Z",
          sampleSize: 240,
        }),
      ],
      // 运行时已经换成 4B 了
      confidenceContext: {
        rerankerModel: "Qwen3-Reranker-4B",
        kbVersion: "kb-2026-03",
        domain: "商品咨询",
      },
    });

    const result = await graph.invoke(
      { query: "问题", tenantId: "t", threadId: "t24-stale", messages: [] },
      { configurable: { thread_id: "t24-stale" } },
    );

    expect(result.confidenceDiagnostics?.stale).toBe(true);
    expect(result.confidenceDiagnostics?.staleReasons.join("\n")).toContain("reranker");
  });
});
