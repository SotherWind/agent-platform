/**
 * rerank 尺度守卫的测试。
 *
 * 这道守卫防的是一个**不报错的**故障：供应商返回原始 logit 时，所有分数都会高于
 * `floor`，于是 `lowConfidence` 恒为 false，闸门静默停止转人工。
 * 所以这里的断言重点不是"会不会抛"，而是"抛出来的信息能不能让人立刻知道该做什么"。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiReranker, assertUnitScaleScores } from "../rerank";
import type { RetrievedChunk } from "../type";

const CTX = { model: "Qwen3-Reranker-4B", baseUrl: "https://ai.gitee.com/v1" };

describe("rerank 尺度守卫", () => {
  it("正常 sigmoid 分数（含边界 0 与 1）不拦", () => {
    expect(() => assertUnitScaleScores([0.9721, 0.5831, 0.0002, 0], CTX)).not.toThrow();
    expect(() => assertUnitScaleScores([1], CTX)).not.toThrow();
    expect(() => assertUnitScaleScores([], CTX)).not.toThrow();
  });

  it("出现负分即判为原始 logit 并报错（bge 模型卡里的真实 logit 量级）", () => {
    expect(() => assertUnitScaleScores([5.26171875, -8.1875], CTX)).toThrow(/\[0,1\]/);
  });

  it("超过 1 同样拦下", () => {
    expect(() => assertUnitScaleScores([0.5, 1.0001], CTX)).toThrow(/不在 \[0,1\]/);
  });

  it("NaN / Infinity 也算越界，不能被当成没问题", () => {
    expect(() => assertUnitScaleScores([Number.NaN], CTX)).toThrow();
    expect(() => assertUnitScaleScores([Number.POSITIVE_INFINITY], CTX)).toThrow();
  });

  it("报错要说清三件事：哪来的、为什么危险、怎么办", () => {
    let message = "";
    try {
      assertUnitScaleScores([3.2, 0.5], CTX);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // 哪来的：模型与地址
    expect(message).toContain("Qwen3-Reranker-4B");
    expect(message).toContain("https://ai.gitee.com/v1");
    // 越界规模与样例
    expect(message).toContain("1/2");
    expect(message).toContain("3.2");
    // 为什么危险：这是关键——不写清楚就会被当成"分数有点怪"而放过
    expect(message).toContain("logit");
    expect(message).toContain("静默停止转人工");
    // 怎么办
    expect(message).toContain("verify:provider");
  });
});

// ─────────────────────────────────────────────────────────────
// 接线验证：上面测的是纯函数，这里证明它真的长在 ApiReranker 的链路上。
// 用 fetch 打桩，不碰任何网络。
// ─────────────────────────────────────────────────────────────

const chunk = (id: string, content: string): RetrievedChunk => ({
  id,
  documentId: "doc.md",
  tenantId: "t",
  content,
  score: 0.5,
  metadata: {},
});

const stubFetch = (payload: unknown, ok = true, status = 200): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({
        ok,
        status,
        statusText: ok ? "OK" : "Bad Request",
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }) as unknown as Response,
    ),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("尺度守卫确实接在 rerank 链路上", () => {
  it("供应商返回原始 logit 时，rerank() 直接抛错（而不是把 logit 当置信度用）", async () => {
    stubFetch({ results: [{ index: 0, relevance_score: 5.26 }] });
    const reranker = new ApiReranker({ apiKey: "k", baseUrl: "https://ai.gitee.com/v1", model: "Qwen3-Reranker-4B" });

    await expect(reranker.rerank("q", [chunk("c1", "内容")], 1)).rejects.toThrow(/logit/);
  });

  it("供应商把分数字段叫 score 而不是 relevance_score 时，也会被拦下（而不是静默变成 undefined）", async () => {
    // 这是换供应商时很现实的坑：字段名不同 → relevance_score 读出 undefined
    // → 若没有守卫，undefined 会一路传进闸门比较，静默失效。
    stubFetch({ results: [{ index: 0, score: 0.87 }] });
    const reranker = new ApiReranker({ apiKey: "k", baseUrl: "https://ai.gitee.com/v1", model: "m" });

    await expect(reranker.rerank("q", [chunk("c1", "内容")], 1)).rejects.toThrow(/\[0,1\]/);
  });

  it("正常 [0,1] 分数照常映射，并把 rerankScore 挂回原 chunk", async () => {
    stubFetch({
      results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.02 },
      ],
    });
    const reranker = new ApiReranker({ apiKey: "k", baseUrl: "https://ai.gitee.com/v1", model: "m" });
    const result = await reranker.rerank("q", [chunk("c1", "甲"), chunk("c2", "乙")], 2);

    expect(result.map((item) => [item.id, item.rerankScore])).toEqual([
      ["c2", 0.91],
      ["c1", 0.02],
    ]);
  });
});
