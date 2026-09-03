/**
 * T8.1 结构化 tracing
 *
 * 现有 Langfuse 注入保留（src/observability.ts），本模块补的是**阶段 span 粒度**：
 * triage / retrieve / rerank / tool / generate / review 各一个 span，
 * 且 span 上带 token 用量、耗时、模型名、降级标记。
 *
 * 自研 span 收集器而不是只靠 Langfuse 的原因：
 * - Langfuse 是异步上报，单测里断言不到
 * - 「traceId 贯穿全链路并可关联到工单」这类断言需要进程内可查的 trace 树
 * - W3C Trace Context 要能透传到 MCP 工具侧（T3.4 的 `_meta`），本地得先有这个结构
 */
import { randomUUID } from "node:crypto";

export type SpanStage =
  | "prefilter"
  | "guardrails"
  | "triage"
  | "rewrite"
  | "retrieve"
  | "rerank"
  | "budget"
  | "specialist"
  | "tools"
  | "orchestrate"
  | "generate"
  | "review"
  | "escalate"
  | "output";

export interface SpanAttributes {
  model?: string;
  tier?: string;
  ticketId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 降级标记（T6.1 要求任何降级都留下可观测标记） */
  degraded?: boolean;
  fallbackFrom?: string;
  toolName?: string;
  toolKind?: string;
  deduped?: boolean;
  confidence?: number;
  lowConfidence?: boolean;
  chunksIn?: number;
  chunksOut?: number;
  /** OTel / GenAI 语义属性，可由调用方直接传入。 */
  [key: string]: unknown;
}

export interface Span {
  /** W3C trace id（32 hex） */
  traceId: string;
  /** W3C span id（16 hex） */
  spanId: string;
  parentSpanId?: string;
  /** 关联的客服工单，不改变 traceId 的稳定性。 */
  ticketId?: string;
  stage: SpanStage;
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: "ok" | "error";
  attributes: SpanAttributes;
  error?: string;
}

/** W3C traceparent: 00-<traceId>-<spanId>-<flags> */
export function traceparent(span: Pick<Span, "traceId" | "spanId">): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

/** 解析 W3C traceparent，用于跨服务串联 */
export function parseTraceparent(header: string): { traceId: string; spanId: string } | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(header.trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase() };
}

function hex(bytes: number): string {
  return randomUUID().replace(/-/g, "").slice(0, bytes);
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}

export interface TracerOptions {
  clock?: () => number;
}

function withSemanticAttributes(
  stage: SpanStage,
  traceId: string,
  spanId: string,
  ticketId: string | undefined,
  attributes: SpanAttributes,
): SpanAttributes {
  const out: SpanAttributes = {
    ...attributes,
    "rag.stage": stage,
    "trace.id": traceId,
    "span.id": spanId,
  };
  if (ticketId) {
    out.ticketId = ticketId;
    out["ticket.id"] = ticketId;
  }
  if (out.model !== undefined && out["gen_ai.request.model"] === undefined) {
    out["gen_ai.request.model"] = out.model;
  }
  if (out.promptTokens !== undefined && out["gen_ai.usage.input_tokens"] === undefined) {
    out["gen_ai.usage.input_tokens"] = out.promptTokens;
  }
  if (out.completionTokens !== undefined && out["gen_ai.usage.output_tokens"] === undefined) {
    out["gen_ai.usage.output_tokens"] = out.completionTokens;
  }
  if (out.totalTokens !== undefined && out["gen_ai.usage.total_tokens"] === undefined) {
    out["gen_ai.usage.total_tokens"] = out.totalTokens;
  }
  if (out.degraded !== undefined && out["rag.degraded"] === undefined) {
    out["rag.degraded"] = out.degraded;
  }
  return out;
}

/**
 * 进程内 span 收集器。
 *
 * 单测直接读 `spans` 断言阶段覆盖与属性；生产可把 `onSpanEnd` 接到 Langfuse / OTel。
 */
export class Tracer {
  private readonly spans: Span[] = [];
  private readonly clock: () => number;
  private readonly active = new Map<string, Span>();

  constructor(options: TracerOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  /** 开一个新 trace（一次会话一个 traceId）。可从上游 traceparent 继续。 */
  startTrace(traceId = hex(32), options: { traceparent?: string } = {}): string {
    const incoming = options.traceparent ? parseTraceparent(options.traceparent) : null;
    return incoming?.traceId ?? traceId;
  }

  /** 开一个 span；传入 traceparent 时会自动沿用 traceId 和父 span。 */
  start(
    stage: SpanStage,
    opts: {
      traceId?: string;
      traceparent?: string;
      name?: string;
      parentSpanId?: string;
      ticketId?: string;
      attributes?: SpanAttributes;
    },
  ): Span {
    const incoming = opts.traceparent ? parseTraceparent(opts.traceparent) : null;
    const traceId = incoming?.traceId ?? opts.traceId ?? hex(32);
    const spanId = hex(16);
    const ticketId = opts.ticketId ?? (opts.attributes?.ticketId as string | undefined);
    const span: Span = {
      traceId,
      spanId,
      parentSpanId: opts.parentSpanId ?? incoming?.spanId,
      ticketId,
      stage,
      name: opts.name ?? stage,
      startedAt: this.clock(),
      status: "ok",
      attributes: withSemanticAttributes(stage, traceId, spanId, ticketId, opts.attributes ?? {}),
    };
    this.active.set(span.spanId, span);
    return span;
  }

  /** 返回可注入 MCP / HTTP metadata 的 W3C 上下文。 */
  context(span: Pick<Span, "traceId" | "spanId">): TraceContext {
    return { traceId: span.traceId, spanId: span.spanId, traceparent: traceparent(span) };
  }

  /** 结束 span */
  end(span: Span, result?: { error?: unknown; attributes?: SpanAttributes }): Span {
    const now = this.clock();
    span.endedAt = now;
    span.durationMs = now - span.startedAt;
    span.attributes.durationMs = span.durationMs;
    span.attributes["duration.ms"] = span.durationMs;
    if (result?.attributes) {
      Object.assign(span.attributes, withSemanticAttributes(
        span.stage,
        span.traceId,
        span.spanId,
        span.ticketId,
        result.attributes,
      ));
    }
    if (result?.error) {
      span.status = "error";
      span.error = result.error instanceof Error ? result.error.message : String(result.error);
      span.attributes["error.type"] = result.error instanceof Error ? result.error.name : "Error";
    }
    this.active.delete(span.spanId);
    this.spans.push(span);
    return span;
  }

  /**
   * 包一层：同步 / 异步都支持，异常自动记为 error span。
   * 这是节点里的推荐用法——保证任何路径都留下 span。
   */
  async span<T>(
    stage: SpanStage,
    opts: {
      traceId?: string;
      traceparent?: string;
      name?: string;
      parentSpanId?: string;
      ticketId?: string;
      attributes?: SpanAttributes;
    },
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.start(stage, opts);
    try {
      const out = await fn(span);
      this.end(span);
      return out;
    } catch (err) {
      this.end(span, { error: err });
      throw err;
    }
  }

  /** 按 trace 取全部 span */
  forTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  /** 按阶段过滤 */
  forStage(stage: SpanStage): Span[] {
    return this.spans.filter((s) => s.stage === stage);
  }

  /** 全部 span（测试与导出用） */
  all(): Span[] {
    return [...this.spans];
  }

  /** 某 trace 的累计 token（T6.3 成本核算需要） */
  totalTokens(traceId: string): number {
    return this.forTrace(traceId).reduce(
      (sum, s) => sum + (s.attributes.totalTokens ?? 0),
      0,
    );
  }

  reset(): void {
    this.spans.length = 0;
    this.active.clear();
  }
}

/** 进程内默认 tracer（便于模块级共享） */
export const tracer = new Tracer();
