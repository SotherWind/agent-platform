import type { ChatTransport, UIMessageChunk } from "ai";
import { nextPipeline } from "../model/pipeline";
import { lastAnalyzeQuery, messageText } from "../model/message-text";
import type {
  AnalyzeResponseBody,
  AskDataUIMessage,
  ChartSpec,
  ClarificationRequest,
  PipelineStatusData,
} from "../model/types";
import { LOCAL_AUTH_HEADERS } from "../model/types";
import { parseSse } from "./parse-sse";

interface TransportBody {
  query?: string;
  clarificationChoice?: string;
}

export class BiAnalyzeChatTransport implements ChatTransport<AskDataUIMessage> {
  constructor(private readonly getSessionId: () => string) {}

  async sendMessages({
    messages,
    abortSignal,
    body,
  }: Parameters<ChatTransport<AskDataUIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const extra = (body ?? {}) as TransportBody;
    const query = extra.query?.trim() || lastAnalyzeQuery(messages) || lastUserText(messages);
    if (!query) {
      throw new Error("query must not be empty");
    }

    const payload: Record<string, string> = {
      query,
      sessionId: this.getSessionId(),
    };
    if (extra.clarificationChoice) {
      payload.clarificationChoice = extra.clarificationChoice;
    }

    const response = await fetch("/api/analyze/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...LOCAL_AUTH_HEADERS,
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }
    if (!response.body) {
      throw new Error("分析流为空");
    }

    const sse = response.body;
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const textId = "answer";
        let pipeline: PipelineStatusData | undefined;
        let textOpened = false;
        const emit = (chunk: UIMessageChunk) => controller.enqueue(chunk);

        emit({ type: "start" });
        try {
          for await (const frame of parseSse(sse, abortSignal)) {
            if (frame.event === "heartbeat") continue;

            if (frame.event === "status") {
              const phase = asPhase(record(frame.data).phase);
              pipeline = nextPipeline(pipeline, { phase });
              emit({ type: "data-pipeline", id: "pipeline", data: pipeline });
              continue;
            }

            if (frame.event === "node") {
              const node = String(record(frame.data).node ?? "");
              pipeline = nextPipeline(pipeline, { phase: "running", node });
              emit({ type: "data-pipeline", id: "pipeline", data: pipeline });
              continue;
            }

            if (frame.event === "clarification") {
              const clarification = asClarification(frame.data);
              if (clarification) {
                emit({ type: "data-clarification", data: clarification });
              }
              continue;
            }

            if (frame.event === "answer") {
              const answer = asAnswer(frame.data);
              if (answer?.finalAnswer) {
                if (!textOpened) {
                  emit({ type: "text-start", id: textId });
                  textOpened = true;
                }
                emit({ type: "text-delta", id: textId, delta: answer.finalAnswer });
                emit({ type: "text-end", id: textId });
              }
              if (answer?.chartSpec && isChartSpec(answer.chartSpec)) {
                emit({ type: "data-chart", data: answer.chartSpec });
              }
              if (answer?.meta) {
                emit({ type: "data-meta", data: answer.meta });
              }
              if (answer?.clarification) {
                const clarification = asClarification(answer.clarification);
                if (clarification) {
                  emit({ type: "data-clarification", data: clarification });
                }
              }
              continue;
            }

            if (frame.event === "error") {
              const message = String(record(frame.data).error ?? "分析失败");
              const code =
                typeof record(frame.data).code === "string"
                  ? String(record(frame.data).code)
                  : undefined;
              pipeline = nextPipeline(pipeline, { phase: "error" });
              emit({ type: "data-pipeline", id: "pipeline", data: pipeline });
              emit({
                type: "data-error",
                data: { message, code },
              });
              if (!textOpened) {
                emit({ type: "text-start", id: textId });
                textOpened = true;
              }
              emit({
                type: "text-delta",
                id: textId,
                delta: code ? `分析失败：${message}（${code}）` : `分析失败：${message}`,
              });
              emit({ type: "text-end", id: textId });
              emit({ type: "error", errorText: message });
              emit({ type: "finish", finishReason: "error" });
              controller.close();
              return;
            }
          }

          if (textOpened === false) {
            emit({ type: "text-start", id: textId });
            emit({ type: "text-end", id: textId });
          }
          emit({ type: "finish" });
          controller.close();
        } catch (error) {
          if (abortSignal?.aborted) {
            emit({ type: "abort" });
            controller.close();
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          pipeline = nextPipeline(pipeline, { phase: "error" });
          emit({ type: "data-pipeline", id: "pipeline", data: pipeline });
          emit({ type: "data-error", data: { message } });
          if (!textOpened) {
            emit({ type: "text-start", id: textId });
            textOpened = true;
          }
          emit({
            type: "text-delta",
            id: textId,
            delta: `分析失败：${message}`,
          });
          emit({ type: "text-end", id: textId });
          emit({ type: "error", errorText: message });
          emit({ type: "finish", finishReason: "error" });
          controller.close();
        }
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

function lastUserText(messages: AskDataUIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return messageText(message);
  }
  return "";
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asPhase(value: unknown): PipelineStatusData["phase"] {
  if (
    value === "started" ||
    value === "running" ||
    value === "completed" ||
    value === "error" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "running";
}

function asAnswer(value: unknown): AnalyzeResponseBody | null {
  const data = record(value);
  if (typeof data.finalAnswer !== "string" && data.chartSpec == null) return null;
  return data as unknown as AnalyzeResponseBody;
}

function asClarification(value: unknown): ClarificationRequest | null {
  const data = record(value);
  if (typeof data.question !== "string" || !data.question.trim()) return null;
  const options = Array.isArray(data.options)
    ? data.options.flatMap((item) => {
        const option = record(item);
        if (typeof option.id !== "string" || typeof option.label !== "string") return [];
        return [{ id: option.id, label: option.label }];
      })
    : undefined;
  return {
    reason: typeof data.reason === "string" ? data.reason : "ambiguous_metric",
    question: data.question,
    options,
  };
}

function isChartSpec(value: unknown): value is ChartSpec {
  const data = record(value);
  return (
    (data.type === "bar" ||
      data.type === "line" ||
      data.type === "pie" ||
      data.type === "table" ||
      data.type === "scatter") &&
    typeof data.title === "string"
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    /* ignore */
  }
  return `分析请求失败（${response.status}）`;
}
