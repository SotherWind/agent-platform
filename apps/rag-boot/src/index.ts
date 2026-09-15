import { buildGraph } from "./agent";
import { AuthenticationContextError } from "./errors";
import {
  isTrustedAuthenticatedContext,
  assertAdmittedInput,
  runAdmitted,
  type AuthenticatedContext,
} from "./access";
import { withConfidenceTone } from "./nodes/confidence";
import { stableStringify } from "./tools/contract";
import { normalizeKnowledgeScope } from "./knowledge-scope";
import {
  MAX_SEGMENT_CHARS,
  SEGMENT_BLOCKED_REPLY,
  contextWindow,
  findSegmentCut,
  type CitationRef,
  type ConfirmationRequest,
  type SegmentPrechecker,
  type StreamEvent,
  type StreamReviewMode,
} from "./stream-review";
import {
  RagBotInput,
  RagBotOutput,
  CreateGraphOptions,
  State,
} from "./type";

interface StoredTurn {
  state: State;
  deltas?: string[];
}

/**
 * 从图的最终状态提取本轮的结构化元数据（citations / 待确认动作单 / 工单号），
 * 附着在 final 事件上供渠道层翻译成前端可渲染的 data part。
 *
 * 确认单识别口径与 reviewNode 的 hasConfirmationEntry 一致：
 * pending 且 finalAnswer 里出现了 proposal id，说明本轮是 T5.3 的「请确认」回复。
 */
function buildFinalMeta(state: any, answer: string): {
  citations?: CitationRef[];
  confirmation?: ConfirmationRequest;
  ticket?: { ticketId: string };
} {
  const citations: CitationRef[] = Array.isArray(state?.citations)
    ? state.citations.map((c: any) => ({
        chunkId: String(c.chunkId),
        documentId: String(c.documentId),
        text: String(c.text ?? ""),
      }))
    : [];

  const pending = Array.isArray(state?.actionProposals)
    ? state.actionProposals.find(
        (p: any) => ["pending", "confirmed"].includes(p?.status) && typeof p?.id === "string" && answer.includes(p.id),
      )
    : undefined;
  const confirmation: ConfirmationRequest | undefined = pending
    ? {
        proposalId: pending.id,
        action: pending.action,
        summary: pending.summary,
        params: pending.params ?? {},
        confirmToken: pending.confirmToken,
        expiresAt: pending.expiresAt,
      }
    : undefined;

  const ticket = state?.ticketId ? { ticketId: String(state.ticketId) } : undefined;
  return {
    ...(citations.length > 0 ? { citations } : {}),
    ...(confirmation ? { confirmation } : {}),
    ...(ticket ? { ticket } : {}),
  };
}

const trustedContextOf = (input: RagBotInput): AuthenticatedContext => {
  const context = input.authContext;
  if (!isTrustedAuthenticatedContext(context)) {
    throw new AuthenticationContextError(
      "AccessGateway must provide a trusted authentication context before graph invocation.",
      { reasonCode: "missing_trusted_context" },
    );
  }
  if (input.tenantId && input.tenantId !== context.tenantId) {
    throw new AuthenticationContextError(
      "Request tenantId does not match the authenticated tenant.",
      { reasonCode: "tenant_identity_mismatch" },
    );
  }
  if (input.principal && input.principal !== context.principal) {
    throw new AuthenticationContextError(
      "Request principal does not match the authenticated principal.",
      { reasonCode: "principal_identity_mismatch" },
    );
  }
  if (input.threadId && input.threadId !== context.threadId) {
    throw new AuthenticationContextError(
      "Request threadId does not match the authenticated session.",
      { reasonCode: "thread_identity_mismatch" },
    );
  }
  return context;
};

const buildStateInput = (input: RagBotInput) => {
  const context = trustedContextOf(input);
  assertAdmittedInput(context, input);
  return {
    query: input.query,
    tenantId: context.tenantId,
    threadId: context.threadId,
    principal: context.principal,
    traceId: context.traceId,
    operationId: context.operationId,
    knowledgeScope: normalizeKnowledgeScope(context.knowledgeScope),
    confirmationProposalId: input.confirmationProposalId,
    confirmationToken: input.confirmationToken,
    // Conversation history comes only from the identity-bound checkpointer.
    messages: [],
    transcriptConfidence: input.transcriptConfidence ?? null,
  };
};

export async function createGraph(options?: CreateGraphOptions) {
  const graph = await buildGraph(options);
  const production = options?.environment === "production" || process.env.NODE_ENV === "production";
  const segmentPrechecker: SegmentPrechecker =
    options?.segmentPrechecker ?? (() => ({ ok: true }));
  const executionConfig = (context: AuthenticatedContext, config?: any) => ({
    ...(config ?? {}),
    // Checkpoint namespace/version and thread overrides are never accepted from callers.
    configurable: { thread_id: context.threadId, ragbootStreamTokens: false },
  });
  const assertSavedIdentity = (context: AuthenticatedContext, saved: Partial<State>) => {
    if (!saved.tenantId) return;
    if (!saved.operationId || saved.tenantId !== context.tenantId || saved.principal !== context.principal ||
        stableStringify(normalizeKnowledgeScope(saved.knowledgeScope)) !== stableStringify(normalizeKnowledgeScope(context.knowledgeScope))) {
      throw new AuthenticationContextError("Stored conversation identity or permissions do not match; start a new thread.");
    }
  };
  const invokeAdmitted = async (input: RagBotInput, config?: any): Promise<StoredTurn> => {
    const stateInput = buildStateInput(input);
    const context = trustedContextOf(input);
    return runAdmitted(context, async () => {
      const safeConfig = executionConfig(context, config);
      const saved = await graph.getState(safeConfig);
      assertSavedIdentity(context, saved.values);
      if (saved.values?.completedOperationId === context.operationId) return { state: saved.values as State };
      const resume = saved.values?.operationId === context.operationId && saved.next.length > 0;
      return { state: await graph.invoke(resume ? null : stateInput, safeConfig) };
    });
  };

  return {
    invoke: async (input: RagBotInput, config?: any): Promise<RagBotOutput> => {
      const { state: result } = await invokeAdmitted(input, config);

      return {
        answer: result.finalAnswer,
        sources: result.citations
          ? result.citations.map((c: any) => c.text)
          : [],
      };
    },
    /**
     * T9.4 采用「先审后发」策略：先完整执行图并完成输出 Guardrails / Reviewer，
     * 再把已通过终审的 finalAnswer 分块发送。这样高风险回复不存在“已发出才被拦回”的路径；
     * 客户端中断发生在 checkpoint 已落盘之后，不会丢失会话状态。
     */
    stream: async function* (input: RagBotInput, config?: any): AsyncGenerator<string> {
      const { state: result } = await invokeAdmitted(input, config);
      const answer = result.finalAnswer ?? "";
      const chunkSize = 24;
      for (let index = 0; index < answer.length; index += chunkSize) {
        yield answer.slice(index, index + chunkSize);
      }
    },
    /**
     * Event delivery starts after execution has been persisted.
     *
     * - strict  ：等价于 stream() 的事件化版本——全文终审通过后按 24 字块 yield delta。
     * - chunked ：开发兼容模式，重放 generate 节点的 custom stream，
     *             按句子边界缓冲成段，段经 segmentPrechecker 预检后 yield；
     *             图结束后 LLM 终审照跑全文，最终答案与已流出内容不一致
     *             （终审拒绝 / 升级人工 / 情绪触发 / 低置信改写）→ yield replace。
     * - async   ：开发兼容模式，逐 token 重放，补救协议同 chunked。
     *
     * 安全语义：chunked 模式下"已流出 = 已过段级预检"；全文 LLM 终审保留，
     * 拦截发生在发送后但会通过 replace 事件显式撤回并给出最终答案——
     * 生产只允许 strict；开发兼容模式不提供先审后发的内容保证。
     */
    streamTokens: async function* (
      input: RagBotInput,
      config?: any,
      options?: { mode?: StreamReviewMode },
    ): AsyncGenerator<StreamEvent> {
      const mode: StreamReviewMode = options?.mode ?? "strict";
      if (production && mode !== "strict") throw new Error("Production streaming requires strict review.");
      const stateInput = buildStateInput(input);

      if (mode === "strict") {
        const { state: result } = await invokeAdmitted(input, config);
        const answer = result.finalAnswer ?? "";
        const sources = result.citations ? result.citations.map((c: any) => c.text) : [];
        const chunkSize = 24;
        for (let index = 0; index < answer.length; index += chunkSize) {
          yield { type: "delta", text: answer.slice(index, index + chunkSize) };
        }
        yield { type: "final", answer, sources, ...buildFinalMeta(result, answer) };
        return;
      }

      // chunked / async：多路消费 custom（token 增量）与 values（最终状态）。
      // configurable 标记是 generate 节点切流的显式开关（getWriter 在 invoke 期间也可能非空）。
      const context = trustedContextOf(input);
      const turn = await runAdmitted<StoredTurn>(context, async () => {
        const safeConfig = executionConfig(context, config);
        const saved = await graph.getState(safeConfig);
        assertSavedIdentity(context, saved.values);
        if (saved.values?.completedOperationId === context.operationId) return { state: saved.values as State };
        const resume = saved.values?.operationId === context.operationId && saved.next.length > 0;
        const stream = await graph.stream(resume ? null : stateInput, {
          ...executionConfig(context, config),
          configurable: {
            thread_id: context.threadId,
            ragbootStreamTokens: true,
          },
          streamMode: ["custom", "values"],
        } as any);
        const deltas: string[] = [];
        let state: State | undefined;
        for await (const item of stream) {
          const [mode, value] = item as [string, any];
          if (mode === "values") state = value;
          if (mode === "custom" && value?.type === "generate-delta" && typeof value.text === "string") {
            deltas.push(value.text);
          }
        }
        if (!state) throw new Error("Graph stream completed without a final state.");
        return { state, deltas };
      });

      let raw = ""; // 生成的完整草稿（与 generate 节点产出一致）
      let sent = ""; // 实际已流出的内容
      let buffer = ""; // chunked 段缓冲
      let blocked = false;
      let blockedReason = "";
      const lastValues = turn.state;

      for (const text of turn.deltas ?? []) {
        raw += text;

        if (mode === "async") {
          sent += text;
          yield { type: "delta", text };
          continue;
        }

        // chunked：攒到句子边界/最大段长 → 预检 → 放行
        buffer += text;
        while (!blocked) {
          const cut = findSegmentCut(buffer, MAX_SEGMENT_CHARS);
          if (cut < 0) break;
          const segment = buffer.slice(0, cut);
          buffer = buffer.slice(cut);
          const verdict = segmentPrechecker(segment, { context: contextWindow(sent) });
          if (!verdict.ok) {
            blocked = true;
            blockedReason = verdict.reason ?? "segment_precheck_failed";
            yield { type: "held", reason: blockedReason };
            break;
          }
          sent += segment;
          yield { type: "delta", text: segment };
        }
      }

      // 冲刷段缓冲尾巴（未被拦时）
      if (!blocked && buffer.length > 0) {
        const verdict = segmentPrechecker(buffer, { context: contextWindow(sent) });
        if (verdict.ok) {
          sent += buffer;
          yield { type: "delta", text: buffer };
        } else {
          blocked = true;
          blockedReason = verdict.reason ?? "segment_precheck_failed";
          yield { type: "held", reason: blockedReason };
        }
      }

      // 对账：图最终答案 vs 已流出内容（含低置信语气包装）
      const finalAnswer = blocked ? SEGMENT_BLOCKED_REPLY : String(lastValues?.finalAnswer ?? "");
      const sources = Array.isArray(lastValues?.citations)
        ? lastValues.citations.map((c: any) => c.text)
        : [];
      const lowConfidence = Boolean(lastValues?.lowConfidence);
      const expectedFinal = withConfidenceTone(raw.trim(), lowConfidence);

      if (blocked) {
        // fail-closed：被拦内容绝不回传
        yield { type: "replace", reason: blockedReason, answer: SEGMENT_BLOCKED_REPLY };
      } else if (finalAnswer.trim() !== expectedFinal.trim()) {
        if (sent.length === 0) {
          // 没有任何内容流出（升级/兜底等）：无需撤回标记，把最终答案当普通增量流出即可
          for (let index = 0; index < finalAnswer.length; index += 24) {
            yield { type: "delta", text: finalAnswer.slice(index, index + 24) };
          }
        } else {
          yield { type: "replace", reason: "content_revised", answer: finalAnswer };
        }
      }
      yield { type: "final", answer: finalAnswer, sources: blocked ? [] : sources,
        ...(blocked ? {} : buildFinalMeta(lastValues, finalAnswer)) };
    },
  };
}

export * from "./type";
export * from "./schema";
export * from "./channels";
export * from "./access";
export * from "./entry-idempotency";
export * from "./prefilter";
export * from "./actions/signal";
export * from "./actions/proposal";
export * from "./actions/proposal-store";
export * from "./actions/dispatcher";
export * from "./session-binding";
export * from "./sqlite-saver";
export * from "./tools/idempotency";
export * from "./tools/contract";
export * from "./guardrails/action";
export * from "./tickets";
export * from "./tools/business";
export * from "./mcp/stateless";
export * from "./mcp/confirmation";
export * from "./state";
export * from "./agent";
export * from "./vectorstore";
export * from "./knowledge-publication";
export * from "./rerank";
export * from "./stream-review";
export * from "./observability/tracer";
export * from "./observability/pii";
