/**
 * rag-boot 流式事件 → Vercel AI SDK UI Message Stream（SSE）适配。
 *
 * 事件协议来自 rag-boot streamTokens（apps/rag-boot/src/stream-review.ts）：
 * - delta   → text-delta（按节奏切片发送，打字机观感）
 * - held    → 静默（随后必有 replace）
 * - replace → data-replace 自定义 part 告知前端撤回，并用新 text part 重发最终答案
 * - final   → 结构化元数据（citations/confirmation/ticket）逐个发 data-* part，再 text-end + finish
 *
 * 线上协议（ai@7 DefaultChatTransport 解析）：
 *   data: {"type":"start"}\n\n
 *   data: {"type":"text-start","id":"..."}\n\n
 *   data: {"type":"text-delta","id":"...","delta":"..."}\n\n
 *   data: {"type":"data-replace","id":"...","data":{...}}\n\n
 *   data: {"type":"data-citations","data":{"citations":[...]} }\n\n
 *   data: {"type":"data-ticket","data":{"ticketId":"..."}}\n\n
 *   data: {"type":"data-confirm","data":{"proposalId":"...","confirmToken":"..."}}\n\n
 *   data: {"type":"text-end","id":"..."}\n\n
 *   data: {"type":"finish","finishReason":"stop"}\n\n
 *   data: [DONE]\n\n
 *
 * 安全语义：strict 模式下发出的内容都通过了全文终审；
 * chunked/async 模式下"已流出 = 已过段级预检"，LLM 终审在生成完成后对全文进行，
 * 不通过则通过 replace 事件撤回已流出内容并给出合规答案。
 * data-confirm 携带的 confirmToken 只发给当前会话客户端（令牌绑定 threadId+principal），
 * 回传时由图内 ProposalService 校验。
 */

import type { StreamEvent } from "@agent-platform/rag-boot";
import { pauseFor } from "./stream-pacing.js";

export const UI_MESSAGE_STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

const SSE_DONE = "data: [DONE]\n\n";

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

interface PacingOptions {
  chunkSize: number;
  delayMs: number;
  isCancelled?: () => boolean;
}

/** 内部：带节奏的文本片段流 */
async function* pacedPieces(
  text: string,
  options: PacingOptions,
  isCancelled: () => boolean,
): AsyncGenerator<string> {
  const size = Math.max(1, Math.trunc(options.chunkSize));
  const delay = Math.max(0, options.delayMs);
  for (let i = 0; i < text.length; i += size) {
    if (isCancelled()) return;
    const piece = text.slice(i, i + size);
    if (!piece) continue;
    if (delay > 0 && !isCancelled()) {
      await new Promise((resolve) => setTimeout(resolve, pauseFor(piece, delay)));
    }
    yield piece;
  }
}

/**
 * 把 rag-boot 事件流包装为标准 UI Message Stream。
 * replace 事件：前端按"最后一个 text part"渲染，旧草稿自动不再展示。
 */
export function coreEventsToUiMessageStream(
  events: AsyncGenerator<StreamEvent>,
  options: PacingOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseFrame(payload)));
      };
      const isCancelled = () => closed || Boolean(options.isCancelled?.());

      enqueue({ type: "start" });
      let textId = "answer";
      let started = false;
      let finished = false;

      try {
        for await (const event of events) {
          if (isCancelled()) break;

          if (event.type === "delta") {
            if (!started) {
              enqueue({ type: "text-start", id: textId });
              started = true;
            }
            for await (const piece of pacedPieces(event.text, options, isCancelled)) {
              enqueue({ type: "text-delta", id: textId, delta: piece });
            }
          } else if (event.type === "replace") {
            if (started) {
              enqueue({ type: "text-end", id: textId });
              started = false;
            }
            enqueue({
              type: "data-replace",
              id: `retract-${textId}`,
              data: { reason: event.reason },
            });
            const seq = Number(textId.replace(/^answer-?/, "")) || 1;
            textId = `answer-${seq + 1}`;
          } else if (event.type === "held") {
            // 静默：拦截详情由随后的 replace 事件统一告知前端
          } else if (event.type === "final") {
            if (!started) {
              enqueue({ type: "text-start", id: textId });
              started = true;
            }
            // 结构化元数据 → 前端可渲染的自定义 data part（二期：引用/工单/确认流）
            if (event.citations && event.citations.length > 0) {
              enqueue({ type: "data-citations", data: { citations: event.citations } });
            }
            if (event.ticket) {
              enqueue({ type: "data-ticket", data: { ticketId: event.ticket.ticketId } });
            }
            if (event.confirmation) {
              enqueue({ type: "data-confirm", data: { ...event.confirmation } });
            }
            enqueue({ type: "text-end", id: textId });
            enqueue({ type: "finish", finishReason: "stop" });
            finished = true;
          }
        }

        if (!finished) {
          // 事件流未正常收尾（异常/提前结束）：保证协议完整
          if (!started) enqueue({ type: "text-start", id: textId });
          enqueue({ type: "text-end", id: textId });
          enqueue({ type: "finish", finishReason: "stop" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[chat] 流式执行失败:", message);
        if (!closed) {
          if (!started) enqueue({ type: "text-start", id: textId });
          enqueue({ type: "text-end", id: textId });
          enqueue({ type: "error", errorText: message });
          enqueue({ type: "finish", finishReason: "error" });
        }
      } finally {
        if (!closed) {
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
          closed = true;
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
}
