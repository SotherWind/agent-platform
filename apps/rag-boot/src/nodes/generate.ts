/**
 * T0.5 生成节点：接真实 LLM
 *
 * 原实现（agent.ts:100-103）是字符串拼接，不是生成。
 * 清单 166 行的判断很直接：在此之上做任何质量评测都没有意义。
 *
 * 四条验收（清单 187 行）：
 * - 调用注入的 LLM 而非拼接模板字符串
 * - prompt 中包含 reranked 上下文与租户约束
 * - 检索为空时不调用 LLM，直接返回兜底话术（省一次调用，也避免模型无中生有）
 * - LLM 抛错时向上抛 LlmTimeoutError 而非静默返回空串
 */
import type { RerankedChunk, AnswerCitation, SpecialistOutput } from "../schema";
import { GENERATE_PROMPT, LOW_CONFIDENCE_NOTE, renderPrompt } from "../prompts";
import { LlmTimeoutError, TenantMissingError } from "../errors";
import { withConfidenceTone } from "./confidence";
import { countTokens } from "../tokens";
import type { Llm, LlmResponse } from "../llm/types";

export const EMPTY_RETRIEVAL_FALLBACK =
  "这个问题我在当前知识库里没有找到可靠依据，先不给你不确定的答案。可以补充一点背景，或回复「转人工」由人工客服跟进。";

export interface GenerateInput {
  query: string;
  sanitizedQuery: string;
  tenantId: string;
  contextChunks: RerankedChunk[];
  /** 专家 / 编排器已经产出的答案。有则复用，无则由本节点生成 */
  draftedAnswer?: string;
  specialistOutputs?: SpecialistOutput[];
  toolResults?: Array<{ name: string; ok: boolean; summary: string }>;
  lowConfidence: boolean;
  history?: Array<{ role: string; content: string }>;
}

export interface GenerateResult {
  answer: string;
  citations: AnswerCitation[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  /** 是否走了兜底（未调用模型） */
  fallback: boolean;
  degraded?: boolean;
  fallbackExhausted?: boolean;
}

/** 纵深防御：生成侧二次过滤跨租户引用（T2.3） */
export function buildCitations(
  chunks: RerankedChunk[],
  tenantId: string,
): AnswerCitation[] {
  return chunks
    .filter((c) => c.tenantId === tenantId)
    .map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      tenantId: c.tenantId,
      text: c.content,
    }));
}

export function buildContextBlock(chunks: RerankedChunk[]): string {
  if (chunks.length === 0) return "（无可用上下文）";
  return chunks
    .map((c, i) => `[${i + 1}] (chunkId=${c.id}) ${c.content}`)
    .join("\n\n");
}

/**
 * 生成最终答案。
 *
 * 入参里 contextChunks 是**已经过 T2.2 预算裁剪**的 chunk，
 * 所以这里拼出来的 prompt 长度是可控的。
 */
export async function generate(
  input: GenerateInput,
  options: {
    llm?: Llm;
    onUsage?: (response: LlmResponse) => void;
    /**
     * 流式支持（T9.5）：提供时且 LLM 支持 stream() 则走流式生成，
     * 每个 token 增量通过 streamWriter 回调外发（LangGraph custom stream）。
     * 不提供或 LLM 不支持时保持原 invoke 路径，行为与用量统计完全不变。
     */
    streamWriter?: (delta: string) => void;
  } = {},
): Promise<GenerateResult> {
  if (!input.tenantId) {
    throw new TenantMissingError("tenantId is required before generation.");
  }

  const citations = buildCitations(input.contextChunks, input.tenantId);

  // 检索为空且没有实时工具结果 → 不调用 LLM，直接兜底。
  // 有工具结果时，工具返回本身就是本轮事实依据，允许模型基于它生成答案。
  if (input.contextChunks.length === 0 && (!input.toolResults || input.toolResults.length === 0)) {
    return {
      answer: EMPTY_RETRIEVAL_FALLBACK,
      citations: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "none",
      fallback: true,
    };
  }

  // 无 LLM：这不合法——本任务的目的就是要求真实生成。
  // 但为了降级链可用（T6.1 全部模型不可用时仍要响应），这里回落到草稿或兜底话术，
  // 并明确标记 fallback，让上层知道这条回复不是模型产出的。
  if (!options.llm) {
    const drafted = input.draftedAnswer?.trim();
    return {
      answer: drafted ? withConfidenceTone(drafted, input.lowConfidence) : EMPTY_RETRIEVAL_FALLBACK,
      citations,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "none",
      fallback: !drafted,
    };
  }

  const system = renderPrompt(GENERATE_PROMPT, {
    tenantId: input.tenantId,
    context: buildContextBlock(input.contextChunks),
    confidenceNote: input.lowConfidence ? LOW_CONFIDENCE_NOTE : "",
  });

  const parts: string[] = [];
  if (input.history && input.history.length > 0) {
    parts.push(
      `【历史对话】\n${input.history
        .slice(-6)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")}`,
    );
  }
  parts.push(`【用户问题】${input.sanitizedQuery || input.query}`);

  if (input.toolResults && input.toolResults.length > 0) {
    parts.push(
      `【工具返回结果】\n${input.toolResults
        .map((t) => `- ${t.name}（${t.ok ? "成功" : "失败"}）：${t.summary}`)
        .join("\n")}`,
    );
  }

  if (input.specialistOutputs && input.specialistOutputs.length > 0) {
    parts.push(
      `【专家结构化结论】\n${JSON.stringify(
        input.specialistOutputs.map((o) => ({
          category: o.category,
          status: o.status,
          answer: o.answer || o.partialAnswer,
          gap: o.gap,
        })),
        null,
        2,
      )}`,
    );
  }

  if (input.draftedAnswer?.trim()) {
    parts.push(`【待定稿草稿】${input.draftedAnswer}`);
  }

  parts.push(`【要求】基于以上上下文与结论，产出给用户的最终回复。只输出回复正文。`);

  const promptText = parts.join("\n\n");
  const llmRequest = {
    system,
    prompt: promptText,
    stage: "generate" as const,
  };
  let res: LlmResponse;
  try {
    if (options.streamWriter && typeof options.llm.stream === "function") {
      // T9.5 流式路径：边生成边外发增量；用量按最终文本精算（countTokens）。
      let full = "";
      let streamFailed: unknown = null;
      try {
        for await (const delta of await options.llm.stream(llmRequest)) {
          if (!delta) continue;
          full += delta;
          options.streamWriter(delta);
        }
      } catch (err) {
        streamFailed = err;
      }

      if (full.length > 0) {
        // 已有部分内容流出：无法原地重试（前缀已发出），如实上抛走对账/兜底
        if (streamFailed) {
          throw new LlmTimeoutError(
            `generate stream failed after partial output: ${streamFailed instanceof Error ? streamFailed.message : String(streamFailed)}`,
            { stage: "generate", cause: streamFailed },
          );
        }
        const promptTokens = countTokens(promptText);
        const completionTokens = countTokens(full);
        res = {
          text: full,
          model: options.llm.model,
          tier: options.llm.tier,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        };
      } else {
        // 流式启动失败且尚无内容流出（常见：端点超时）→ 回落全量 invoke。
        // T6.1 语义：绝不因流式失败而丢回复。
        res = await options.llm.invoke(llmRequest);
      }
    } else {
      res = await options.llm.invoke(llmRequest);
    }
  } catch (err) {
    // 归一化：调用方（T6.1 降级链）只依赖 AgentError.retryable 决策
    if (err instanceof LlmTimeoutError) throw err;
    throw new LlmTimeoutError(
      `generate failed: ${err instanceof Error ? err.message : String(err)}`,
      { stage: "generate", cause: err },
    );
  }

  options.onUsage?.(res);
  const answer = res.text.trim();
  if (!answer) {
    throw new LlmTimeoutError("generate returned empty output", { stage: "generate" });
  }

  return {
    answer: withConfidenceTone(answer, input.lowConfidence),
    citations,
    usage: {
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      totalTokens: res.totalTokens,
    },
    model: res.model,
    fallback: Boolean(res.fallbackExhausted),
    degraded: res.degraded,
    fallbackExhausted: Boolean(res.fallbackExhausted),
  };
}
