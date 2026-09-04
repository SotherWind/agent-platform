import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  BuildGraphConfig,
  State,
  StateUpdate,
  VectorStoreType,
  Reranker,
  AgentGraphNode,
  Reranker as RerankerType,
} from "./type";
import { createVectorStore } from "./vectorstore";
import { AgentState } from "./state";
import { getTracingCallbacks } from "./observability";
import { TenantMissingError, BudgetExceededError, GuardrailBlockedError } from "./errors";
import type { Llm, LlmResponse, LlmTask } from "./llm/types";
import { LlmFallbackChain, DEFAULT_TASK_TIER } from "./llm/degradation";
import { createChatLlm } from "./llm/chat";
import { Prefilter } from "./prefilter";
import { InputGuardrails } from "./guardrails/input";
import { Reviewer } from "./guardrails/output";
import { triage } from "./nodes/triage";
import { rewriteQuery } from "./nodes/rewrite";
import { retrieve, rerank } from "./nodes/retrieve";
import { applyContextBudget } from "./nodes/budget";
import { computeConfidence, adjustForTranscriptConfidence } from "./nodes/confidence";
import { runSpecialists } from "./nodes/specialist";
import { getSpecialist } from "./nodes/specialists";
import { orchestrate } from "./nodes/orchestrator";
import { generate, EMPTY_RETRIEVAL_FALLBACK } from "./nodes/generate";
import {
  evaluateEscalation,
  buildHandoffPackage,
  isHumanRequest,
  DEFAULT_SENTIMENT_INTENSITY_THRESHOLD,
} from "./escalation";
import { scoreSentiment } from "./sentiment";
import { executeTool, assertToolRegistry, type AgentTool } from "./tools/contract";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./tools/idempotency";
import { InMemoryTicketStore, TicketService } from "./tickets";
import { Tracer, tracer as defaultTracer, type SpanAttributes } from "./observability/tracer";

/** 没有配置 Qdrant 时的安全空实现：仍可运行 FAQ / 直答 / 测试，不会偷偷联网。 */
const EMPTY_VECTOR_STORE: VectorStoreType = {
  async search() {
    return [];
  },
  async addDocuments() {
    return 0;
  },
  async ingestFile() {
    return 0;
  },
  async deleteByDocumentId() {},
};

function contentOf(message: BaseMessage | { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String(part.text);
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

function stateHistory(state: State): Array<{ role: string; content: string }> {
  return (state.messages ?? []).map((message: BaseMessage) => ({
    role: message.getType?.() ?? "user",
    content: contentOf(message),
  }));
}

function asLlmList(value: Llm | Llm[] | undefined): Llm[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveConfiguredLlm(
  task: LlmTask,
  config: BuildGraphConfig,
): Llm | undefined {
  const direct = config.llmRouter?.[task];
  if (direct) return direct;

  const tier = DEFAULT_TASK_TIER[task];
  const tiers = config.llms ?? {};
  const preferred = asLlmList(tiers[tier]);
  if (preferred.length > 0) {
    return preferred.length === 1
      ? preferred[0]
      : new LlmFallbackChain(preferred, { maxRetries: 0 });
  }

  // 任务未配置专属档位时，使用已注入的任意模型作为测试/开发兜底。
  for (const candidateTier of ["large", "small", "simple"] as const) {
    const candidates = asLlmList(tiers[candidateTier]);
    if (candidates.length > 0) {
      return candidates.length === 1
        ? candidates[0]
        : new LlmFallbackChain(candidates, { maxRetries: 0 });
    }
  }

  return undefined;
}

async function resolveDefaultLlm(config: BuildGraphConfig): Promise<Llm | undefined> {
  const configured = Object.values(config.llmRouter ?? {}).find(Boolean) as Llm | undefined;
  if (configured) return configured;
  if (Object.values(config.llms ?? {}).some((value) => asLlmList(value).length > 0)) {
    return undefined;
  }

  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) return undefined;

  const { createChatLlm: create } = await import("./llm/chat");
  return create({
    model: process.env.MODEL_NAME ?? "gpt-4o-mini",
    apiKey,
    baseUrl: process.env.MODEL_BASE_URL,
    tier: "large",
  });
}

type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls: number;
  model?: string;
  tier?: string;
  degraded?: boolean;
};

function emptyUsage(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };
}

function addUsage(target: UsageTotals, response: LlmResponse): void {
  target.promptTokens += response.promptTokens;
  target.completionTokens += response.completionTokens;
  target.totalTokens += response.totalTokens;
  target.llmCalls += 1;
  target.model = response.model;
  target.tier = response.tier;
  target.degraded ||= Boolean(response.degraded || response.fallbackExhausted);
}

function budgetWithUsage(state: State, usage: UsageTotals): StateUpdate {
  return {
    budget: {
      ...state.budget,
      promptTokens: state.budget.promptTokens + usage.promptTokens,
      completionTokens: state.budget.completionTokens + usage.completionTokens,
      totalTokens: state.budget.totalTokens + usage.totalTokens,
      llmCalls: state.budget.llmCalls + usage.llmCalls,
    },
  };
}

function usageAttributes(state: State, update: StateUpdate): SpanAttributes {
  const budget = update.budget;
  if (!budget) return {};
  return {
    promptTokens: Math.max(0, (budget.promptTokens ?? state.budget.promptTokens) - state.budget.promptTokens),
    completionTokens: Math.max(0, (budget.completionTokens ?? state.budget.completionTokens) - state.budget.completionTokens),
    totalTokens: Math.max(0, (budget.totalTokens ?? state.budget.totalTokens) - state.budget.totalTokens),
    llmCalls: Math.max(0, (budget.llmCalls ?? state.budget.llmCalls) - state.budget.llmCalls),
  };
}

function mergeBudget(state: State, patch: Partial<State["budget"]>): StateUpdate {
  return { budget: { ...state.budget, ...patch } };
}

function currentToolResults(state: State): Array<{ name: string; ok: boolean; summary: string }> {
  return (state.toolCalls ?? []).map((call) => ({
    name: call.name,
    ok: call.ok,
    summary: call.summary,
  }));
}

function currentTurnToolCalls(state: State) {
  return (state.toolCalls ?? []).filter((call) => call.turnIndex === state.turnCount);
}

function specialistToolAllowlist(state: State): string[] {
  const categories = state.triage?.categories ?? ["general"];
  return [...new Set(categories.flatMap((category) => getSpecialist(category).toolNames))];
}

function withSpan(
  tracer: Tracer,
  stage: Parameters<Tracer["start"]>[0],
  fn: (state: State) => Promise<StateUpdate> | StateUpdate,
  attributes?: (state: State, update: StateUpdate) => SpanAttributes,
): AgentGraphNode {
  return async (state: State) => {
    const traceId = state.traceId || tracer.startTrace();
    const span = tracer.start(stage, {
      traceId,
      name: `rag.${stage}`,
      ticketId: state.ticketId ?? undefined,
      attributes: {
        threadId: state.threadId,
        turnCount: state.turnCount,
      },
    });
    try {
      const update = await fn(state);
      const updateTicketId = typeof update.ticketId === "string" ? update.ticketId : undefined;
      if (updateTicketId) {
        span.ticketId = updateTicketId;
        span.attributes.ticketId = updateTicketId;
        span.attributes["ticket.id"] = updateTicketId;
      }
      tracer.end(span, {
        attributes: {
          "rag.stage": stage,
          ...(attributes ? attributes(state, update) : {}),
        },
      });
      return { ...update, traceId };
    } catch (error) {
      tracer.end(span, { error });
      throw error;
    }
  };
}

function routeAfterSpecialist(
  state: State,
  maxToolTurns: number,
): "tools" | "orchestrate" | "escalate" {
  if (state.route === "escalate") return "escalate";
  if ((state.pendingToolRequests ?? []).length > 0 && state.toolTurns < maxToolTurns) return "tools";
  if (state.triage?.needsRealtimeData && currentTurnToolCalls(state).length === 0) {
    return state.toolTurns < maxToolTurns ? "tools" : "escalate";
  }
  return "orchestrate";
}

function routeAfterTools(
  state: State,
  maxToolTurns: number,
): "specialist" | "review" | "escalate" {
  if (state.route === "review") return "review";
  if (state.route === "escalate") return "escalate";
  if (state.toolTurns >= maxToolTurns) return "escalate";
  return "specialist";
}

function routeAfterReview(
  state: State,
  sentimentThreshold: number = DEFAULT_SENTIMENT_INTENSITY_THRESHOLD,
): "output" | "escalate" {
  if (state.terminationReason === "all_models_failed") return "escalate";
  if (state.review && !state.review.passed) return "escalate";
  if (state.consecutiveFallbackTurns >= 2) return "escalate";
  if (state.consecutiveLowConfidenceTurns >= 2) return "escalate";
  if (state.consecutiveReviewFailures >= 2) return "escalate";
  // T5.1 情绪触发。此前 evaluateEscalation 支持该分支但路由不看 sentiment，
  // 于是「极度负面」永远走不到 humanEscalation —— 情绪触发是死代码。
  // 阈值必须与 evaluateEscalation 一致，否则会出现判定要升级、路由却直出的矛盾。
  if (state.sentiment === "negative" && state.sentimentIntensity >= sentimentThreshold) {
    return "escalate";
  }
  return "output";
}

/**
 * 构建带持久化、分诊、检索预算、工具循环、终审和人工升级的 Agent 图。
 * 所有外部依赖均可通过 BuildGraphConfig 注入；未注入时走安全降级而不是联网猜测。
 */
export const buildGraph = async (configs: BuildGraphConfig = {}) => {
  const checkpointer = configs.checkpointer ?? new MemorySaver();
  const store =
    configs.vectorStore ??
    (process.env.QDRANT_URL || process.env.QDRANT_API_KEY || process.env.USE_QDRANT === "true"
      ? await createVectorStore()
      : EMPTY_VECTOR_STORE);
  const reranker: Reranker | null =
    configs.reranker !== undefined
      ? configs.reranker
      : process.env.RERANK_API_KEY
        ? (await import("./rerank")).createApiReranker()
        : null;

  const fallbackLlm = await resolveDefaultLlm(configs);
  const llmFor = (task: LlmTask): Llm | undefined =>
    resolveConfiguredLlm(task, configs) ?? fallbackLlm;

  const prefilter = configs.prefilter ?? new Prefilter();
  const inputGuardrails = configs.inputGuardrails ?? new InputGuardrails();
  const reviewer = configs.reviewer ?? new Reviewer({ llm: llmFor("review") });
  const toolRegistry = configs.tools ?? [];
  if (toolRegistry.length > 0) assertToolRegistry(toolRegistry);
  const idempotency: IdempotencyStore = configs.idempotency ?? new InMemoryIdempotencyStore();
  const ticketService = configs.ticketService ?? new TicketService({ store: new InMemoryTicketStore() });
  const graphTracer = configs.tracer ?? defaultTracer;
  const actionGuardrails = configs.actionGuardrails;
  const maxToolTurns = Math.max(1, configs.maxToolTurns ?? 5);
  // 情绪触发阈值：路由判断与 evaluateEscalation 共用一份配置，避免两处漂移
  const sentimentThreshold =
    configs.escalationPolicy?.sentimentIntensityThreshold ?? DEFAULT_SENTIMENT_INTENSITY_THRESHOLD;
  const maxContextTokens = configs.maxContextTokens ?? 1500;
  const maxChunks = configs.maxChunks ?? 5;
  const confidenceThreshold = configs.confidenceThreshold ?? 0.35;
  const sessionTokenBudget = configs.sessionTokenBudget ?? 12_000;

  const turnStart = withSpan(graphTracer, "prefilter", async (state) => {
    // T2.3 fail-closed：租户检查放在图的**最入口**，而不是等到检索节点。
    // 等到 retrieve 才拒绝的话，无模型/升级路径会带着空租户跑完整条链路。
    if (!state.tenantId) throw new TenantMissingError();
    const traceId = state.traceId || graphTracer.startTrace();
    const nextTurn = state.turnCount + 1;
    // T5.1：情绪在本轮入口打分，escalateNode 靠它触发 negative_sentiment。
    // 此前全链路无人计算，evaluateEscalation 的情绪分支实际上是死代码。
    // 每轮重算 => 天然不跨轮残留，无需像 transcriptConfidence 那样手工清空。
    const sentiment = scoreSentiment(state.query);
    return {
      traceId,
      sentiment: sentiment.sentiment,
      sentimentIntensity: sentiment.intensity,
      threadId: state.threadId || `thread-${traceId.slice(0, 12)}`,
      confirmationProposalId: state.confirmationProposalId,
      confirmationToken: state.confirmationToken,
      turnCount: nextTurn,
      toolTurns: 0,
      // 固化本轮的 ASR 转写置信度并清空入参，避免跨轮残留（T9.1）
      asrTranscriptConfidence: state.transcriptConfidence,
      transcriptConfidence: null,
      budget: {
        ...state.budget,
        toolTurns: 0,
      },
      toolsCalledThisTurn: false,
      pendingToolRequests: [],
      specialistOutputs: [],
      orchestratedAnswer: "",
      finalAnswer: "",
      citations: [],
      review: null,
      escalation: null,
      handoff: null,
      ticketId: null,
      terminationReason: "",
      prefilterHit: null,
      directAnswer: "",
      sanitizedQuery: "",
      rewrittenQuery: "",
      retrievedDocs: [],
      rerankedDocs: [],
      contextChunks: [],
      confidence: null,
      lowConfidence: false,
      route: "pending",
    };
  });

  const prefilterNode = withSpan(graphTracer, "prefilter", async (state) => {
    const result = prefilter.run(state.query, { tenantId: state.tenantId });
    if (result.action === "direct") {
      return {
        prefilterHit: result.hit,
        directAnswer: result.answer,
        finalAnswer: result.answer,
        route: "direct" as const,
        ...mergeBudget(state, { savedTokens: state.budget.savedTokens + result.savedTokens }),
      };
    }
    if (result.action === "escalate") {
      return {
        prefilterHit: result.hit,
        route: "escalate" as const,
        finalAnswer: "好的，我会为你转接人工客服，请稍候。",
        ...mergeBudget(state, { savedTokens: state.budget.savedTokens + result.savedTokens }),
      };
    }
    if (result.action === "block") {
      return {
        prefilterHit: result.hit,
        route: "direct" as const,
        finalAnswer: result.answer,
        ...mergeBudget(state, { savedTokens: state.budget.savedTokens + result.savedTokens }),
      };
    }
    return {};
  });

  const guardrailNode = withSpan(graphTracer, "guardrails", async (state) => {
    const result = inputGuardrails.run(state.query, {
      tenantId: state.tenantId,
      threadId: state.threadId,
    });
    if (result.blocked) {
      return {
        sanitizedQuery: result.sanitized,
        finalAnswer: result.blockReason ?? EMPTY_RETRIEVAL_FALLBACK,
        prefilterHit: "blacklist",
        route: "direct" as const,
      };
    }
    return { sanitizedQuery: result.sanitized };
  });

  const triageNode = withSpan(graphTracer, "triage", async (state) => {
    const nodeUsage = emptyUsage();
    const result = await triage(
      {
        query: state.sanitizedQuery || state.query,
        history: stateHistory(state),
        humanRequested: isHumanRequest(state.query),
      },
      { llm: llmFor("triage"), onUsage: (response) => addUsage(nodeUsage, response) },
    );
    const route = result.likelyNeedsHuman || result.urgency === "high" ? "escalate" : "specialist";
    return { triage: result, route, ...budgetWithUsage(state, nodeUsage) };
  }, (state, update) => {
    const triageResult = update.triage ?? state.triage;
    return {
      model: llmFor("triage")?.model,
      tier: llmFor("triage")?.tier,
      ...usageAttributes(state, update),
      ...(triageResult ? {
        urgency: triageResult.urgency,
        likelyNeedsHuman: triageResult.likelyNeedsHuman,
        needsRealtimeData: triageResult.needsRealtimeData,
      } : {}),
    };
  });

  const rewriteNode = withSpan(graphTracer, "rewrite", async (state) => {
    const nodeUsage = emptyUsage();
    const result = await rewriteQuery(
      { query: state.sanitizedQuery || state.query, history: stateHistory(state) },
      { llm: llmFor("rewrite"), onUsage: (response) => addUsage(nodeUsage, response) },
    );
    return {
      rewrittenQuery: result.query,
      ...budgetWithUsage(state, nodeUsage),
      ...(result.degradedReason ? { degradations: `rewrite:${result.degradedReason}` } : {}),
    };
  }, (state, update) => ({
    model: llmFor("rewrite")?.model,
    tier: llmFor("rewrite")?.tier,
    ...usageAttributes(state, update),
    degraded: Boolean(update.degradations),
    rewritten: update.rewrittenQuery !== undefined,
  }));

  const retrieveNode = withSpan(graphTracer, "retrieve", async (state) => {
    if (!state.tenantId) throw new TenantMissingError();
    const result = await retrieve(store, {
      query: state.rewrittenQuery || state.sanitizedQuery || state.query,
      tenantId: state.tenantId,
      topK: 20,
      topN: maxChunks,
    });
    return {
      retrievedDocs: result.chunks,
      ...(result.degradedReason ? { degradations: `retrieve:${result.degradedReason}` } : {}),
    };
  }, (_state, update) => ({
    chunksOut: update.retrievedDocs?.length ?? 0,
    degraded: Boolean(update.degradations),
  }));

  const rerankNode = withSpan(graphTracer, "rerank", async (state) => {
    const result = await rerank(
      reranker,
      state.rewrittenQuery || state.sanitizedQuery || state.query,
      state.retrievedDocs,
      maxChunks,
    );
    return {
      rerankedDocs: result.chunks,
      ...(result.degradedReason ? { degradations: `rerank:${result.degradedReason}` } : {}),
    };
  }, (state, update) => ({
    chunksIn: state.retrievedDocs.length,
    chunksOut: update.rerankedDocs?.length ?? 0,
    degraded: Boolean(update.degradations),
  }));

  const budgetNode = withSpan(graphTracer, "budget", async (state) => {
    const result = applyContextBudget(state.rerankedDocs, {
      maxTokens: maxContextTokens,
      maxChunks,
    });
    const nextBudget = {
      ...state.budget,
      contextTokens: result.tokens,
    };
    if (state.budget.totalTokens + result.tokens > sessionTokenBudget) {
      return {
        contextChunks: result.chunks,
        budget: nextBudget,
        terminationReason: "session_token_budget_exceeded",
        route: "escalate" as const,
      };
    }
    return { contextChunks: result.chunks, budget: nextBudget };
  }, (state, update) => ({
    chunksIn: state.rerankedDocs.length,
    chunksOut: update.contextChunks?.length ?? 0,
    contextTokens: update.budget?.contextTokens ?? state.budget.contextTokens,
    totalTokens: update.budget?.totalTokens ?? state.budget.totalTokens,
  }));

  const confidenceNode = withSpan(graphTracer, "retrieve", async (state) => {
    const base = computeConfidence(state.contextChunks, { threshold: confidenceThreshold });
    // T9.1：ASR 低置信转写要拉低整体置信度。问题文本本身没听清时，
    // 检索得再准也不能算高置信——否则会给用户一个看起来很确定的错答案。
    const score = adjustForTranscriptConfidence(base.score, state.asrTranscriptConfidence);
    const lowConfidence = base.lowConfidence || score < confidenceThreshold;
    return {
      confidence: score,
      lowConfidence,
      consecutiveLowConfidenceTurns: lowConfidence
        ? state.consecutiveLowConfidenceTurns + 1
        : 0,
      // 转写置信度拉低了结果时留下可观测标记（T6.1 的降级可观测要求）
      ...(state.asrTranscriptConfidence !== null && score < base.score
        ? { degradations: `asr_transcript_confidence:${state.asrTranscriptConfidence}` }
        : {}),
    };
  }, (state, update) => ({
    confidence: update.confidence ?? undefined,
    lowConfidence: update.lowConfidence,
    asrTranscriptConfidence: state.asrTranscriptConfidence ?? undefined,
  }));

  const specialistNode = withSpan(graphTracer, "specialist", async (state) => {
    const nodeUsage = emptyUsage();
    const outputs = await runSpecialists(
      {
        categories: state.triage?.categories ?? ["general"],
        query: state.query,
        sanitizedQuery: state.sanitizedQuery,
        contextChunks: state.contextChunks,
        toolResults: currentToolResults(state),
        calledToolNames: currentTurnToolCalls(state).map((call) => call.name),
        lowConfidence: state.lowConfidence,
      },
      { llm: llmFor("specialist"), onUsage: (response) => addUsage(nodeUsage, response) },
    );
    const requests = outputs.flatMap((output) => output.toolRequests);
    const escalationRequested = outputs.some((output) => output.status === "escalate");
    return {
      specialistOutputs: outputs,
      pendingToolRequests: requests,
      ...budgetWithUsage(state, nodeUsage),
      route: escalationRequested ? ("escalate" as const) : ("specialist" as const),
    };
  }, (state, update) => ({
    model: llmFor("specialist")?.model,
    tier: llmFor("specialist")?.tier,
    ...usageAttributes(state, update),
    categories: state.triage?.categories,
    outputs: update.specialistOutputs?.length ?? 0,
    toolRequests: update.pendingToolRequests?.length ?? 0,
  }));

  const toolsNode = withSpan(graphTracer, "tools", async (state) => {
    if (state.toolTurns >= maxToolTurns) {
      return {
        route: "escalate" as const,
        terminationReason: "max_tool_turns",
        finalAnswer: EMPTY_RETRIEVAL_FALLBACK,
      };
    }

    const request = state.pendingToolRequests[0] as
      | { name?: unknown; args?: Record<string, unknown> }
      | undefined;
    if (!request || typeof request.name !== "string") {
      if (state.triage?.needsRealtimeData && currentTurnToolCalls(state).length === 0) {
        return {
          route: "escalate" as const,
          terminationReason: "realtime_tool_required_but_not_requested",
          finalAnswer: "这个问题需要查询实时业务数据，但当前无法安全完成查询，已为你转人工确认。",
        };
      }
      return { route: "specialist" as const };
    }

    const tool = toolRegistry.find((candidate) => candidate.name === request.name);
    if (!tool) {
      return {
        route: "escalate" as const,
        terminationReason: "tool_not_registered",
        finalAnswer: EMPTY_RETRIEVAL_FALLBACK,
      };
    }

    const args = request.args ?? {};
    const allowlist = specialistToolAllowlist(state);
    if (!allowlist.includes(tool.name)) {
      return {
        route: "escalate" as const,
        terminationReason: "tool_boundary_violation",
        finalAnswer: "当前请求超出该问题所属专家的工具权限范围，已为你转人工处理。",
      };
    }

    const isWrite = tool.kind === "write";
    const storedProposal = state.actionProposals.find(
      (candidate) => candidate.action === tool.name &&
        (candidate.status === "pending" || candidate.status === "confirmed"),
    );
    let proposal = storedProposal && configs.proposalService
      ? configs.proposalService.get(storedProposal.id) ?? storedProposal
      : storedProposal;
    if (
      configs.proposalService &&
      state.confirmationProposalId &&
      state.confirmationToken &&
      state.confirmationProposalId === storedProposal?.id &&
      storedProposal?.status === "pending"
    ) {
      try {
        proposal = configs.proposalService.confirm({
          proposalId: state.confirmationProposalId,
          token: state.confirmationToken,
          threadId: state.threadId,
          principal: state.principal,
        });
      } catch {
        return {
          route: "escalate" as const,
          terminationReason: "confirmation_invalid",
          finalAnswer: "确认信息无效或已过期，已为你转人工确认。",
        };
      }
    }

    const actionRequest = {
      toolName: tool.name,
      kind: tool.kind,
      allowlist,
      principal: state.principal,
      confirmed: Boolean(proposal && proposal.status === "confirmed"),
      amountCents: typeof args.amountCents === "number" ? args.amountCents : undefined,
    };
    const actionVerdict = actionGuardrails?.check(actionRequest);
    if (actionVerdict && !actionVerdict.allowed &&
        !(isWrite && actionVerdict.code === "confirmation_required" && !proposal)) {
      return {
        route: "escalate" as const,
        terminationReason: `action_guardrail:${actionVerdict.code}`,
        finalAnswer: "这个操作未通过安全校验，我已为你转人工确认。",
      };
    }

    if (isWrite && (!proposal || proposal.status !== "confirmed")) {
      if (!configs.proposalService) {
        return {
          route: "escalate" as const,
          terminationReason: "proposal_service_unavailable",
          finalAnswer: "当前无法安全生成动作确认单，已为你转人工处理。",
        };
      }
      const nextProposal = proposal ?? configs.proposalService.propose({
        action: tool.name,
        params: args,
        summary: tool.description,
        tenantId: state.tenantId,
        threadId: state.threadId,
        principal: state.principal,
      });
      const proposals = state.actionProposals.some((item) => item.id === nextProposal.id)
        ? state.actionProposals.map((item) => item.id === nextProposal.id ? nextProposal : item)
        : [...state.actionProposals, nextProposal];
      return {
        actionProposals: proposals,
        pendingToolRequests: [],
        finalAnswer: `我可以帮你执行：${nextProposal.summary}\n请确认后继续处理（确认单：${nextProposal.id}）。`,
        route: "review" as const,
      };
    }

    // 写操作只允许通过结构化 ActionSignal 投递给业务系统；Agent 图不直接调用 CRM 写接口。
    if (isWrite) {
      if (!configs.signalBus) {
        return {
          route: "escalate" as const,
          terminationReason: "signal_bus_unavailable",
          finalAnswer: "动作已确认，但业务系统信号通道暂不可用，已转人工确保不会重复执行。",
        };
      }
      const signal = await configs.signalBus.emit({
        type: tool.name,
        tenantId: state.tenantId,
        threadId: state.threadId,
        principal: state.principal,
        payload: args,
        idempotencyKey: proposal?.idempotencyKey ?? `${state.threadId}:${tool.name}:${state.turnCount}`,
        decisionBasis: state.citations.map((citation) => citation.chunkId),
      });
      const executedProposal = proposal && configs.proposalService
        ? { ...proposal, status: "executed" as const }
        : undefined;
      return {
        actionSignals: [...state.actionSignals, signal],
        ...(executedProposal ? {
          actionProposals: state.actionProposals.map((item) => item.id === executedProposal.id ? executedProposal : item),
        } : {}),
        toolTurns: state.toolTurns + 1,
        toolsCalledThisTurn: true,
        pendingToolRequests: [],
        finalAnswer: `动作已确认并提交业务系统处理（信号：${signal.id}）。`,
        toolCalls: {
          name: tool.name,
          kind: tool.kind,
          ok: true,
          idempotencyKey: signal.idempotencyKey,
          deduped: false,
          summary: JSON.stringify(signal),
          turnIndex: state.turnCount,
          at: (configs.clock ?? Date.now)(),
          error: null,
        },
        budget: { ...state.budget, toolTurns: state.budget.toolTurns + 1 },
        route: "review" as const,
      };
    }

    try {
      const result = await executeTool(tool, args, {
        tenantId: state.tenantId,
        threadId: state.threadId,
        principal: state.principal,
        turnIndex: state.turnCount,
        idempotency,
        audit: () => {},
        clock: configs.clock,
      });
      const summary = JSON.stringify(result.result ?? null);
      const nextToolTurns = state.toolTurns + 1;
      return {
        toolTurns: nextToolTurns,
        toolsCalledThisTurn: true,
        pendingToolRequests: state.pendingToolRequests.slice(1),
        toolCalls: {
          name: tool.name,
          kind: tool.kind,
          ok: result.ok,
          idempotencyKey: result.idempotencyKey,
          deduped: result.deduped,
          summary,
          turnIndex: state.turnCount,
          at: (configs.clock ?? Date.now)(),
          error: null,
        },
        budget: { ...state.budget, toolTurns: state.budget.toolTurns + 1 },
        // T1.2：轮次撞上限时把终止原因写进 state（routeAfterTools 据此升级人工，
        // 而 router 本身无法写 state，必须在节点里落盘）
        ...(nextToolTurns >= maxToolTurns ? { terminationReason: "max_tool_turns" } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextToolTurns = state.toolTurns + 1;
      return {
        toolTurns: nextToolTurns,
        toolsCalledThisTurn: true,
        pendingToolRequests: state.pendingToolRequests.slice(1),
        toolCalls: {
          name: tool.name,
          kind: tool.kind,
          ok: false,
          idempotencyKey: "blocked",
          deduped: false,
          summary: message,
          turnIndex: state.turnCount,
          at: (configs.clock ?? Date.now)(),
          error: message,
        },
        ...(nextToolTurns >= maxToolTurns ? { terminationReason: "max_tool_turns" } : {}),
      };
    }
  }, (state, update) => ({
    toolName: state.pendingToolRequests[0]?.name as string | undefined,
    toolTurns: update.toolTurns ?? state.toolTurns,
    toolKind: state.pendingToolRequests[0]?.kind as string | undefined,
    degraded: update.route === "escalate",
  }));

  const orchestrateNode = withSpan(graphTracer, "orchestrate", async (state) => {
    const nodeUsage = emptyUsage();
    const result = await orchestrate(state.specialistOutputs, {
      llm: llmFor("orchestrate"),
      onUsage: (response) => addUsage(nodeUsage, response),
    });
    return {
      orchestratedAnswer: result.answer,
      conflictResolved: result.conflictResolved,
      ...budgetWithUsage(state, nodeUsage),
    };
  }, (state, update) => ({
    model: llmFor("orchestrate")?.model,
    tier: llmFor("orchestrate")?.tier,
    ...usageAttributes(state, update),
    outputs: state.specialistOutputs.length,
    conflictResolved: (update.conflictResolved ?? []).length,
  }));

  const generateNode = withSpan(graphTracer, "generate", async (state) => {
    const nodeUsage = emptyUsage();
    const result = await generate(
      {
        query: state.query,
        sanitizedQuery: state.sanitizedQuery,
        tenantId: state.tenantId,
        contextChunks: state.contextChunks,
        draftedAnswer: state.orchestratedAnswer,
        specialistOutputs: state.specialistOutputs,
        toolResults: currentToolResults(state),
        lowConfidence: state.lowConfidence,
        history: stateHistory(state),
      },
      { llm: llmFor("generate"), onUsage: (response) => addUsage(nodeUsage, response) },
    );
    // generate() 会把同一份响应同时放进 result.usage 与 onUsage，
    // 这里只取一处累加，否则每次生成会被计两遍。
    const nextBudget = {
      ...state.budget,
      promptTokens: state.budget.promptTokens + nodeUsage.promptTokens,
      completionTokens: state.budget.completionTokens + nodeUsage.completionTokens,
      totalTokens: state.budget.totalTokens + nodeUsage.totalTokens,
      llmCalls: state.budget.llmCalls + nodeUsage.llmCalls,
    };
    const budgetExceeded = nextBudget.totalTokens > sessionTokenBudget;
    return {
      finalAnswer: result.answer,
      citations: result.citations,
      consecutiveFallbackTurns: result.fallback ? state.consecutiveFallbackTurns + 1 : 0,
      budget: nextBudget,
      ...(result.degraded ? { degradations: `generate:${result.model}` } : {}),
      ...(result.fallbackExhausted ? { terminationReason: "all_models_failed" } : {}),
      ...(budgetExceeded ? {
        terminationReason: "session_token_budget_exceeded",
        route: "escalate" as const,
      } : {}),
      ...(result.fallbackExhausted ? { route: "escalate" as const } : {}),
    };
  }, (state, update) => ({
    model: llmFor("generate")?.model,
    tier: llmFor("generate")?.tier,
    ...usageAttributes(state, update),
    degraded: Boolean(update.degradations) || update.terminationReason === "all_models_failed",
    lowConfidence: state.lowConfidence,
  }));

  const reviewNode = withSpan(graphTracer, "review", async (state) => {
    const nodeUsage = emptyUsage();
    const verdict = await reviewer.review({
      answer: state.finalAnswer,
      citations: state.citations,
      hasActionProposal: state.actionProposals.some((proposal) => proposal.status === "pending"),
      hasConfirmationEntry: state.actionProposals.some((proposal) =>
        proposal.status === "pending" && state.finalAnswer.includes(proposal.id),
      ),
      tenantId: state.tenantId,
      attempt: state.consecutiveReviewFailures + 1,
      onUsage: (response) => addUsage(nodeUsage, response),
    });
    return {
      review: verdict,
      consecutiveReviewFailures: verdict.passed
        ? 0
        : state.consecutiveReviewFailures + 1,
      ...budgetWithUsage(state, nodeUsage),
    };
  }, (state, update) => ({
    reviewer: (reviewer as Reviewer).constructor.name,
    reviewPassed: update.review?.passed,
    reviewAttempts: update.review?.attempts,
    model: llmFor("review")?.model,
    tier: llmFor("review")?.tier,
    ...usageAttributes(state, update),
  }));

  const escalateNode = withSpan(graphTracer, "escalate", async (state) => {
    const decision = evaluateEscalation(
      {
        userAskedForHuman: isHumanRequest(state.query),
        // 本轮 turnStart 打的分（T5.1 negative_sentiment 触发源）
        sentiment: state.sentiment,
        sentimentIntensity: state.sentimentIntensity,
        consecutiveFallbackTurns: state.consecutiveFallbackTurns,
        consecutiveReviewFailures: state.consecutiveReviewFailures,
        consecutiveLowConfidenceTurns: state.consecutiveLowConfidenceTurns,
        triageLikelyNeedsHuman: state.triage?.likelyNeedsHuman,
        triageUrgency: state.triage?.urgency,
        budgetExceeded: state.terminationReason === "session_token_budget_exceeded",
        allModelsFailed: state.finalAnswer === EMPTY_RETRIEVAL_FALLBACK,
        policyViolation: state.review?.passed === false,
      },
      configs.escalationPolicy,
    );
    const transcript = stateHistory(state).map((entry, index) => ({
      role: entry.role === "human" ? "user" : entry.role === "ai" ? "assistant" : "tool",
      content: entry.content,
      at: index,
    })) as Array<{ role: "user" | "assistant" | "system" | "tool"; content: string; at: number }>;
    const handoff = buildHandoffPackage({
      threadId: state.threadId,
      tenantId: state.tenantId,
      transcript,
      draftReply: state.finalAnswer || EMPTY_RETRIEVAL_FALLBACK,
      decision: decision.required
        ? decision
        : { required: true, triggers: ["policy_violation"], reasons: ["进入人工兜底路径"] },
      citations: state.citations,
      retrievedContext: state.contextChunks,
      confidence: state.confidence,
      clock: configs.clock,
    });
    let ticketId: string | null = null;
    try {
      const ticket = await ticketService.create({
        tenantId: state.tenantId,
        threadId: state.threadId,
        category: state.triage?.categories[0] ?? "general",
        subject: state.query,
        handoff,
        humanInvolved: true,
        idempotencyKey: `escalation:${state.threadId}:${state.turnCount}`,
      });
      ticketId = ticket.id;
    } catch {
      // 人工队列不可用时仍保留交接包，不能吞掉用户响应。
    }
    // 终审不通过时，被拦回的草稿只进交接包（上面已 buildHandoff），绝不发给用户——
    // 否则「高风险回复不存在已发出才被拦截的路径」（T9.4 验收）就被这条拼接绕过了。
    // state.review 在 turnStart 每轮重置为 null，这里读到的一定是本轮判定，无跨轮残留。
    const reviewRejected = state.review?.passed === false;
    const userFacingAnswer =
      !reviewRejected && state.finalAnswer && state.finalAnswer !== EMPTY_RETRIEVAL_FALLBACK
        ? `${state.finalAnswer}\n\n我已为你转接人工客服，请稍候。`
        : "当前无法在安全范围内完成回答，我已为你转接人工客服，请稍候。";
    return {
      escalation: decision.required
        ? decision
        : { required: true, triggers: ["policy_violation"], reasons: ["进入人工兜底路径"] },
      handoff,
      ticketId,
      finalAnswer: userFacingAnswer,
      route: "escalate" as const,
    };
  });

  const outputNode = withSpan(graphTracer, "output", async () => ({}));

  const workflow = new StateGraph(AgentState)
    .addNode("turnStart", turnStart)
    .addNode("prefilter", prefilterNode)
    .addNode("guardrails", guardrailNode)
    .addNode("triageDecision", triageNode)
    .addNode("rewrite", rewriteNode)
    .addNode("retrieve", retrieveNode)
    .addNode("rerank", rerankNode)
    .addNode("contextBudget", budgetNode)
    .addNode("confidenceCheck", confidenceNode)
    .addNode("specialistNode", specialistNode)
    .addNode("toolExecutor", toolsNode)
    .addNode("orchestration", orchestrateNode)
    .addNode("answerGeneration", generateNode)
    .addNode("outputReview", reviewNode)
    .addNode("humanEscalation", escalateNode)
    .addNode("output", outputNode)
    .addEdge(START, "turnStart")
    .addEdge("turnStart", "prefilter")
    .addConditionalEdges("prefilter", (state) => state.route, {
      direct: "output",
      escalate: "humanEscalation",
      pending: "guardrails",
      specialist: "guardrails",
    })
    .addConditionalEdges("guardrails", (state) => state.route, {
      direct: "output",
      escalate: "humanEscalation",
      pending: "triageDecision",
      specialist: "triageDecision",
    })
    .addConditionalEdges("triageDecision", (state) => state.route, {
      escalate: "humanEscalation",
      specialist: "rewrite",
      direct: "output",
      pending: "rewrite",
    })
    .addEdge("rewrite", "retrieve")
    .addEdge("retrieve", "rerank")
    .addEdge("rerank", "contextBudget")
    .addEdge("contextBudget", "confidenceCheck")
    .addConditionalEdges("confidenceCheck", (state) => state.route, {
      escalate: "humanEscalation",
      specialist: "specialistNode",
      pending: "specialistNode",
      direct: "output",
    })
    .addConditionalEdges("specialistNode", (state) => routeAfterSpecialist(state, maxToolTurns), {
      tools: "toolExecutor",
      orchestrate: "orchestration",
      escalate: "humanEscalation",
    })
    .addConditionalEdges("toolExecutor", (state) => routeAfterTools(state, maxToolTurns), {
      specialist: "specialistNode",
      review: "outputReview",
      escalate: "humanEscalation",
    })
    .addEdge("orchestration", "answerGeneration")
    .addConditionalEdges("answerGeneration", (state) =>
      state.route === "escalate" ? "escalate" : "review",
      {
        review: "outputReview",
        escalate: "humanEscalation",
      },
    )
    .addConditionalEdges(
      "outputReview",
      (state) => routeAfterReview(state, sentimentThreshold),
      {
        output: "output",
        escalate: "humanEscalation",
      },
    )
    .addEdge("humanEscalation", "output")
    .addEdge("output", END);

  const compiled = workflow.compile({ checkpointer });
  const originalInvoke = compiled.invoke.bind(compiled);
  const originalStream = compiled.stream.bind(compiled);

  const injectCallbacks = (config?: any) => {
    const callbacks = getTracingCallbacks();
    let existing = config?.callbacks || [];
    if (!Array.isArray(existing)) existing = [existing];
    return { ...config, callbacks: [...existing, ...callbacks] };
  };

  return Object.assign(compiled, {
    invoke: async (
      state: Parameters<typeof originalInvoke>[0],
      config?: Parameters<typeof originalInvoke>[1],
    ) => {
      const input = state as Partial<State>;
      const threadId = input.threadId || (config as any)?.configurable?.thread_id;
      const nextConfig = {
        ...(config ?? {}),
        configurable: {
          ...((config as any)?.configurable ?? {}),
          ...(threadId ? { thread_id: threadId } : {}),
        },
      };
      return originalInvoke(
        { ...state, ...(threadId ? { threadId } : {}) },
        injectCallbacks(nextConfig),
      );
    },
    stream: async (
      state: Parameters<typeof originalStream>[0],
      config?: Parameters<typeof originalStream>[1],
    ) => {
      const input = state as Partial<State>;
      const threadId = input.threadId || (config as any)?.configurable?.thread_id;
      const nextConfig = {
        ...(config ?? {}),
        configurable: {
          ...((config as any)?.configurable ?? {}),
          ...(threadId ? { thread_id: threadId } : {}),
        },
      };
      return originalStream(
        { ...state, ...(threadId ? { threadId } : {}) },
        injectCallbacks(nextConfig),
      );
    },
  });
};
