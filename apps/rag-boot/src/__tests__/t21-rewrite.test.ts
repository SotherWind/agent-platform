/**
 * T2.1 查询改写
 *
 * 依据 Fin：先把会话摘要成短查询，再检索。
 *
 * 验收（清单 305 行）：改写失败必须降级而非报错。
 */
import { rewriteQuery } from "../nodes/rewrite";
import { createFakeLlm } from "../llm/fake";
import { LlmTimeoutError } from "../errors";

describe("查询改写", () => {
  it("多轮省略指代能被还原（『它多少钱』→『Pro 套餐多少钱』）", async () => {
    const llm = createFakeLlm({ reply: "Pro 套餐多少钱" });
    const result = await rewriteQuery(
      {
        query: "它多少钱",
        history: [
          { role: "user", content: "你们有什么套餐" },
          { role: "assistant", content: "有基础版和 Pro 套餐" },
        ],
      },
      { llm },
    );

    expect(result.rewritten).toBe(true);
    expect(result.query).toBe("Pro 套餐多少钱");
    expect(result.degradedReason).toBeNull();
    expect(llm.callsFor("rewrite")).toHaveLength(1);
  });

  it("首轮无历史时不改写，直接透传", async () => {
    const llm = createFakeLlm({ reply: "不该被调用" });
    const result = await rewriteQuery({ query: "退款规则是什么", history: [] }, { llm });

    // 首轮透传：模型一次都不调（省一次调用，也避免模型把干净查询改坏）
    expect(llm.calls).toHaveLength(0);
    expect(result).toEqual({ query: "退款规则是什么", rewritten: false, degradedReason: null });
  });

  it("改写失败时回退到原始 query，不阻断检索", async () => {
    // 模型抛错
    const failing = createFakeLlm({ failWith: new LlmTimeoutError("boom") });
    const failed = await rewriteQuery(
      { query: "它多少钱", history: [{ role: "user", content: "之前的问题" }] },
      { llm: failing },
    );
    expect(failed.query).toBe("它多少钱");
    expect(failed.rewritten).toBe(false);
    expect(failed.degradedReason).toBeTruthy();

    // 模型输出为空同样回退
    const empty = createFakeLlm({ reply: "   " });
    const emptyResult = await rewriteQuery(
      { query: "它多少钱", history: [{ role: "user", content: "之前的问题" }] },
      { llm: empty },
    );
    expect(emptyResult.query).toBe("它多少钱");
    expect(emptyResult.degradedReason).toContain("empty");

    // 模型输出长到离谱（在胡说）也回退
    const long = createFakeLlm({ reply: "长".repeat(200) });
    const longResult = await rewriteQuery(
      { query: "它多少钱", history: [{ role: "user", content: "之前的问题" }] },
      { llm: long },
    );
    expect(longResult.query).toBe("它多少钱");
    expect(longResult.rewritten).toBe(false);
  });
});
