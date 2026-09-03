/**
 * T2.1 查询改写
 *
 * 依据 Fin：先把会话摘要成短查询，再检索。当前实现直接拿 state.query 原文检索，
 * 「它多少钱」这种带指代的第二轮问题检索不到任何东西。
 *
 * 硬规则（清单 305 行）：**改写失败必须降级而非报错**。
 * 改写的收益是提高召回，失败的最坏情况只是回到原样——绝不该让检索链路因此中断。
 */
import { REWRITE_PROMPT } from "../prompts";
import type { Llm, LlmResponse } from "../llm/types";

export interface RewriteInput {
  query: string;
  history: Array<{ role: string; content: string }>;
}

export interface RewriteResult {
  query: string;
  /** 是否发生了改写 */
  rewritten: boolean;
  /** 降级原因（改写失败时非空） */
  degradedReason: string | null;
}

/**
 * 查询改写。
 *
 * 首轮无历史时直接透传，不调用模型——省一次调用，也避免模型把干净的查询改坏。
 */
export async function rewriteQuery(
  input: RewriteInput,
  options: { llm?: Llm; onUsage?: (response: LlmResponse) => void } = {},
): Promise<RewriteResult> {
  const hasHistory = input.history.length > 0;
  if (!hasHistory || !options.llm) {
    return { query: input.query, rewritten: false, degradedReason: null };
  }

  const prompt = [
    `【历史对话】`,
    input.history
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n"),
    `【当前问题】${input.query}`,
    `【改写后的检索查询】`,
  ].join("\n");

  try {
    const res = await options.llm.invoke({
      system: REWRITE_PROMPT.system,
      prompt,
      temperature: 0,
      stage: "rewrite",
    });
    options.onUsage?.(res);

    const rewritten = res.text
      .trim()
      .replace(/^["'「」【】]/, "")
      .replace(/["'「」【】]$/, "")
      .trim();

    // 模型返回空或长到离谱（说明它在胡说）→ 回退原文
    if (!rewritten || rewritten.length > 120) {
      return {
        query: input.query,
        rewritten: false,
        degradedReason: "rewrite output empty or too long",
      };
    }

    return { query: rewritten, rewritten: true, degradedReason: null };
  } catch (err) {
    return {
      query: input.query,
      rewritten: false,
      degradedReason: err instanceof Error ? err.message : String(err),
    };
  }
}
