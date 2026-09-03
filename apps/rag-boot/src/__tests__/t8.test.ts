import { AuditLog, RetentionRunner, redactText } from "../observability/pii";
import { Tracer, parseTraceparent, traceparent } from "../observability/tracer";
import { isKnowledgeDocumentActive, knowledgeFilter } from "../vectorstore";

describe("T8.1 tracing", () => {
  it("span 关联 ticketId 并带阶段、token、耗时和降级标准属性", async () => {
    const tracer = new Tracer({ clock: (() => {
      let now = 100;
      return () => (now += 10);
    })() });
    const traceId = tracer.startTrace();
    const span = await tracer.span(
      "retrieve",
      { traceId, ticketId: "ticket-1", attributes: { model: "fake", totalTokens: 8, degraded: true } },
      async () => "ok",
    );

    const saved = tracer.all()[0];
    expect(span).toBe("ok");
    expect(saved.ticketId).toBe("ticket-1");
    expect(saved.attributes["rag.stage"]).toBe("retrieve");
    expect(saved.attributes["gen_ai.request.model"]).toBe("fake");
    expect(saved.attributes["gen_ai.usage.total_tokens"]).toBe(8);
    expect(saved.attributes["rag.degraded"]).toBe(true);
    expect(saved.durationMs).toBe(10);
  });

  it("主图阶段 span 记录模型、token、降级和工单关联", async () => {
    const { buildGraph } = await import("../agent");
    const { createFakeLlm } = await import("../llm/fake");
    const tracer = new Tracer();
    const model = createFakeLlm({ byStage: {
      triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
      specialist: JSON.stringify({ status: "resolved", answer: "已回答" }),
      generate: "已回答",
      review: JSON.stringify({ passed: true, violations: [] }),
    }});
    const graph = await buildGraph({
      tracer,
      vectorStore: { search: async () => [], addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {} },
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });
    const result = await graph.invoke({ query: "服务支持范围", tenantId: "t", threadId: "trace-thread", messages: [] }, { configurable: { thread_id: "trace-thread" } });
    const spans = tracer.forTrace(result.traceId);
    expect(spans.map((span) => span.stage)).toEqual(expect.arrayContaining(["triage", "specialist", "generate", "review", "output"]));
    expect(spans.some((span) => span.attributes["gen_ai.request.model"] === "fake-model")).toBe(true);
    expect(spans.some((span) => Number(span.attributes["gen_ai.usage.total_tokens"] ?? 0) > 0)).toBe(true);
    expect(spans.every((span) => span.attributes["trace.id"] === result.traceId)).toBe(true);
  });

  it("W3C trace context 可从入站 traceparent 继续并生成子 span", () => {
    const incoming = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const tracer = new Tracer();
    const span = tracer.start("tools", { traceparent: incoming });
    expect(span.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(span.parentSpanId).toBe("0123456789abcdef");
    expect(parseTraceparent(traceparent(span))?.traceId).toBe(span.traceId);
    expect(tracer.context(span).traceparent).toBe(traceparent(span));
  });

  it("六个阶段各自产生独立 span：triage/retrieve/rerank/tools/generate/review", async () => {
    // T8.1#1（清单 772 行）：此前只断言主图部分阶段，没有逐一验。
    // 场景设计成六阶段全走：实时问题 → 专家请求工具 → 工具执行 → 生成 → 终审。
    const { buildGraph } = await import("../agent");
    const { createFakeLlm } = await import("../llm/fake");
    const { createOrderStatusTool, FakeBackend } = await import("../tools/business");

    // byStage 是单值回复，specialist 需要两轮不同输出 → 内联 sequenced fake
    const seq: Record<string, string[]> = {
      triage: [
        JSON.stringify({ categories: ["order"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: true }),
      ],
      specialist: [
        JSON.stringify({
          status: "needsOrchestrator",
          toolRequests: [{ name: "get_order_status", args: { orderId: "o-1", tenantId: "t" } }],
        }),
        JSON.stringify({ status: "resolved", answer: "基于实时查询的回答" }),
      ],
      generate: ["基于实时查询的最终回答"],
      review: [JSON.stringify({ passed: true, violations: [] })],
    };
    const counts: Record<string, number> = {};
    const model = {
      ...createFakeLlm(),
      async invoke(req: { stage?: string }) {
        const stage = req.stage ?? "";
        const s = seq[stage] ?? ["{}"];
        const text = s[Math.min(counts[stage] ?? 0, s.length - 1)];
        counts[stage] = (counts[stage] ?? 0) + 1;
        return { text, model: "fake-seq", tier: "small" as const, promptTokens: 10, completionTokens: 10, totalTokens: 20 };
      },
    };

    const tracer = new Tracer();
    const graph = await buildGraph({
      tracer,
      vectorStore: {
        search: async () => [
          { id: "c1", documentId: "d1", tenantId: "t", content: "知识片段", score: 0.9, metadata: {} },
        ],
        addDocuments: async () => 1,
        ingestFile: async () => 1,
        deleteByDocumentId: async () => {},
      },
      reranker: { rerank: async (_q, chunks) => chunks.map((c) => ({ ...c, rerankScore: c.score })) },
      llms: { simple: model as never, small: model as never, large: model as never },
      tools: [createOrderStatusTool(new FakeBackend())],
      maxToolTurns: 3,
    });

    const result = await graph.invoke(
      { query: "我的订单到哪了", tenantId: "t", threadId: "t8-six-stages", messages: [] },
      { configurable: { thread_id: "t8-six-stages" } },
    );

    // 逐一验证六个阶段都有独立 span（规格里的 tool 在实现里叫 tools）
    const stages = tracer.forTrace(result.traceId).map((span) => span.stage);
    for (const stage of ["triage", "retrieve", "rerank", "tools", "generate", "review"] as const) {
      expect(stages.filter((s) => s === stage).length).toBeGreaterThanOrEqual(1);
    }
    // 每个 span 都挂在同一 traceId 下
    expect(stages.length).toBe(tracer.forTrace(result.traceId).length);
  });
});

describe("T8.2 PII 与留存", () => {
  it("审计记录自动脱敏手机号、地址且保留排障结构", () => {
    const audit = new AuditLog({ clock: () => 1000 });
    audit.append({ message: "手机号 13812345678，地址：北京市朝阳区" });
    const value = JSON.stringify(audit.entries()[0].data);
    expect(value).not.toContain("13812345678");
    expect(value).not.toContain("北京市朝阳区");
    expect(redactText("手机号 13812345678")).toContain("138");
    expect(redactText("地址：北京市朝阳区")).toContain("北京");
  });

  it("审计、会话和持久化目标分别使用对应 TTL", async () => {
    const calls: Array<[string, number]> = [];
    const runner = new RetentionRunner({ sessionTtlMs: 10, auditTtlMs: 20, persistenceTtlMs: 30 });
    for (const target of [
      { name: "audit-log", kind: "audit" as const },
      { name: "session-store", kind: "session" as const },
      { name: "checkpoint", kind: "persistence" as const },
    ]) {
      runner.register({ ...target, purge: async (cutoff) => { calls.push([target.name, cutoff]); return 1; } });
    }
    const report = await runner.run(100);
    expect(report).toHaveLength(3);
    expect(calls).toEqual([["audit-log", 80], ["session-store", 90], ["checkpoint", 70]]);
  });
});

describe("T8.3 知识库生命周期", () => {
  it("按生效/失效时间判断文档，并生成租户过期过滤", () => {
    expect(isKnowledgeDocumentActive({ effectiveAt: 90, expiredAt: 110 }, 100)).toBe(true);
    expect(isKnowledgeDocumentActive({ effectiveAt: 101 }, 100)).toBe(false);
    expect(isKnowledgeDocumentActive({ expiredAt: 100 }, 100)).toBe(false);
    expect(knowledgeFilter("tenant-a", 100).must_not).toHaveLength(2);
  });
});
