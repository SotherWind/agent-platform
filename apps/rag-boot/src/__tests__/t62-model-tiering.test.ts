/**
 * T6.2 模型按任务复杂度分级
 *
 * 依据 Swiggy：简单模型 / 小推理模型 / 大推理模型三档。
 *
 * 验收（清单 624 行）：模型选择结果可观测且可被评测集回放。
 */
import { ModelRouter, DEFAULT_TASK_TIER } from "../llm/degradation";
import { buildGraph } from "../agent";
import { createFakeLlm, type FakeLlm } from "../llm/fake";
import type { Llm } from "../llm/types";

function tiers(): { simple: FakeLlm; small: FakeLlm; large: FakeLlm } {
  return {
    simple: createFakeLlm({ model: "simple-model", tier: "simple", reply: "{}" }),
    small: createFakeLlm({ model: "small-model", tier: "small", reply: "{}" }),
    large: createFakeLlm({ model: "large-model", tier: "large", reply: "{}" }),
  };
}

describe("模型分级", () => {
  it("triage 用小模型", () => {
    // 分派从主 Agent 解耦到专用轻量模型（Swiggy）
    expect(DEFAULT_TASK_TIER.triage).toBe("simple");
    expect(DEFAULT_TASK_TIER.rewrite).toBe("simple");
    // 专家/编排用小推理档，生成用大档
    expect(DEFAULT_TASK_TIER.specialist).toBe("small");
    expect(DEFAULT_TASK_TIER.generate).toBe("large");

    const t = tiers();
    const router = new ModelRouter({ simple: [t.simple], small: [t.small], large: [t.large] });
    const chain = router.resolve("triage");
    expect(chain.model).toBe("simple-model");
  });

  it("简单 FAQ 用简单模型（直答路径零模型消耗）", async () => {
    // 简单 FAQ 在前置层直答（T9.3），一档模型都不用调 —— 这是比「用简单模型」更优的解
    const t = tiers();
    const graph = await buildGraph({
      vectorStore: { search: async () => [], addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {} },
      reranker: null,
      llms: { simple: t.simple, small: t.small, large: t.large },
    });
    const result = await graph.invoke(
      { query: "怎么开发票", tenantId: "t", threadId: "t62-faq", messages: [] },
      { configurable: { thread_id: "t62-faq" } },
    );
    expect(result.finalAnswer).toContain("发票管理");
    for (const llm of [t.simple, t.small, t.large]) {
      expect(llm.calls).toHaveLength(0);
    }

    // 需要模型的任务（rewrite 默认 simple 档）从 simple 档起步
    const router = new ModelRouter({ simple: [t.simple], small: [t.small], large: [t.large] });
    expect(router.resolve("rewrite").model).toBe("simple-model");
  });

  it("复杂多意图工单用大模型", () => {
    const t = tiers();
    // 复杂度升级规则：多类别/高紧急 → 强制大档
    const router = new ModelRouter(
      { simple: [t.simple], small: [t.small], large: [t.large] },
      {
        escalateTierOn: ({ categories, urgency }) =>
          categories.length > 1 || urgency === "high" ? "large" : null,
      },
    );

    // 多意图（账单 + 集成）→ large
    expect(router.resolveTier("specialist", { categories: ["billing", "integration"] })).toBe("large");
    expect(router.resolve("specialist", { categories: ["billing", "integration"] }).model).toBe("large-model");
    // 高紧急度 → large
    expect(router.resolveTier("specialist", { urgency: "high" })).toBe("large");
    // 普通单意图 → 默认 small
    expect(router.resolveTier("specialist", { categories: ["billing"] })).toBe("small");
    expect(router.resolve("specialist", { categories: ["billing"] }).model).toBe("small-model");
  });

  it("模型选择结果可观测且可被评测集回放", () => {
    const t = tiers();
    const router = new ModelRouter(
      { simple: [t.simple], small: [t.small], large: [t.large] },
      {
        escalateTierOn: ({ categories }) => (categories.length > 1 ? "large" : null),
      },
    );
    const ctx = { categories: ["billing", "integration"], urgency: "normal" };

    // 纯函数：同样输入必然同样输出 —— 这是「可回放」的定义
    const first = router.resolveTier("specialist", ctx);
    const second = router.resolveTier("specialist", ctx);
    expect(first).toBe(second);
    expect(first).toBe("large");

    // 可观测：resolve 返回的降级链首模型就是被选中的模型
    const chain = router.resolve("specialist", ctx) as Llm;
    expect(chain.model).toBe("large-model");
    // 评测集回放侧：DEFAULT_TASK_TIER 导出后可被 runner 固定复现
    expect(Object.keys(DEFAULT_TASK_TIER).sort()).toEqual(
      ["generate", "orchestrate", "review", "rewrite", "specialist", "triage"].sort(),
    );
  });
});
