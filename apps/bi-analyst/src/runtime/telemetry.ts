import { randomBytes, randomUUID } from "node:crypto";

export type SpanStatus = "ok" | "error" | "unset";

export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  endTime?: string;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean | null>;
  events?: Array<{
    name: string;
    time: string;
    attributes?: Record<string, string | number | boolean | null>;
  }>;
}

export interface TelemetrySnapshot {
  spans: TelemetrySpan[];
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean | null): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean | null>): void;
  end(status?: SpanStatus): void;
  recordException(error: unknown): void;
}

export interface TelemetryOptions {
  maxSpans?: number;
  serviceName?: string;
  otlpEndpoint?: string;
  fetchImpl?: typeof fetch;
}

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export class Telemetry {
  private readonly spans: TelemetrySpan[] = [];
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly maxSpans: number;
  private readonly serviceName: string;
  private readonly otlpEndpoint?: string;
  private readonly fetchImpl: typeof fetch;
  private pendingExport: Promise<void> = Promise.resolve();

  constructor(options: TelemetryOptions = {}) {
    this.maxSpans = Math.min(Math.max(100, options.maxSpans ?? 5_000), 100_000);
    this.serviceName = options.serviceName ?? "bi-analyst";
    this.otlpEndpoint = options.otlpEndpoint?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  startSpan(
    name: string,
    attributes: Record<string, string | number | boolean | null> = {},
    parent?: Pick<SpanHandle, "traceId" | "spanId">,
  ): SpanHandle {
    const span: TelemetrySpan = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      parentSpanId: parent?.spanId,
      name,
      startTime: new Date().toISOString(),
      status: "unset",
      attributes: {
        "service.name": this.serviceName,
        ...attributes,
      },
      events: [],
    };
    let ended = false;
    const handle: SpanHandle = {
      traceId: span.traceId,
      spanId: span.spanId,
      setAttribute: (key, value) => {
        if (!ended) span.attributes[key] = value;
      },
      addEvent: (eventName, eventAttributes) => {
        if (ended) return;
        span.events?.push({
          name: eventName,
          time: new Date().toISOString(),
          attributes: eventAttributes,
        });
      },
      end: (status = span.status === "error" ? "error" : "ok") => {
        if (ended) return;
        ended = true;
        span.status = status;
        span.endTime = new Date().toISOString();
        this.spans.push(span);
        if (this.spans.length > this.maxSpans) {
          this.spans.splice(0, this.spans.length - this.maxSpans);
        }
        this.queueExport(span);
      },
      recordException: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        handle.setAttribute("error.type", error instanceof Error ? error.name : "Error");
        handle.setAttribute("error.message", message.slice(0, 500));
        handle.addEvent("exception", { "exception.message": message.slice(0, 500) });
        if (!ended) span.status = "error";
      },
    };
    return handle;
  }

  increment(name: string, value = 1): number {
    const next = (this.counters.get(name) ?? 0) + value;
    this.counters.set(name, next);
    return next;
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  snapshot(): TelemetrySnapshot {
    return {
      spans: this.spans.map((span) => ({
        ...span,
        attributes: { ...span.attributes },
        events: span.events?.map((event) => ({ ...event, attributes: event.attributes && { ...event.attributes } })),
      })),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  reset(): void {
    this.spans.length = 0;
    this.counters.clear();
    this.gauges.clear();
  }

  async flush(): Promise<void> {
    await this.pendingExport;
  }

  private queueExport(span: TelemetrySpan): void {
    if (!this.otlpEndpoint) return;
    this.pendingExport = this.pendingExport
      .then(async () => {
        try {
          await this.fetchImpl(this.otlpEndpoint!, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              resourceSpans: [
                {
                  resource: { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] },
                  scopeSpans: [{ spans: [toOtlpSpan(span)] }],
                },
              ],
            }),
          });
        } catch {
          // Telemetry must never change request behavior.
        }
      })
      .catch(() => undefined);
  }
}

function toOtlpSpan(span: TelemetrySpan): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    startTimeUnixNano: String(Date.parse(span.startTime) * 1_000_000),
    endTimeUnixNano: String(Date.parse(span.endTime ?? span.startTime) * 1_000_000),
    status: { code: span.status === "ok" ? 1 : span.status === "error" ? 2 : 0 },
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { intValue: value } : { stringValue: value ?? "" },
    })),
    events: span.events?.map((event) => ({
      name: event.name,
      timeUnixNano: String(Date.parse(event.time) * 1_000_000),
      attributes: Object.entries(event.attributes ?? {}).map(([key, value]) => ({
        key,
        value: typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { intValue: value } : { stringValue: value ?? "" },
      })),
    })),
  };
}

export function parseTraceParent(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return match?.[1];
}

export function createDefaultTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  return new Telemetry({
    maxSpans: Number(env.OTEL_MAX_SPANS ?? 5_000),
    serviceName: env.OTEL_SERVICE_NAME ?? "bi-analyst",
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
}
