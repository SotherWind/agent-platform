/**
 * T9.5 流式输出 + 终审语义（调研定稿：分段缓冲审查，对齐 Azure/NeMo/阿里云实践）
 *
 * 三种模式：
 * - strict  ：先审后发（原 stream() 行为）——图整体跑完、终审通过后按块发送。监管最严。
 * - chunked ：分段缓冲——token 按句子边界缓冲成段，每段经轻量预检后放出；
 *             生成完成后 LLM 终审照跑全文，若最终答案与已流出内容不一致
 *             （终审拒绝 / 升级人工 / 情绪触发），发出 replace 事件由前端替换。
 * - async   ：先发后审——token 零缓冲直出（极致首字延迟），补救协议同 chunked。
 *
 * 事件协议（供 server 翻译成 UI Message Stream）：
 * - {type:"delta", text}    可安全显示的增量文本
 * - {type:"held", reason}   预检拦截，后续增量停止（fail-closed）
 * - {type:"replace", reason, answer}  已流出内容需整体替换为 answer
 * - {type:"final", answer, sources}   一轮结束（answer 为图最终答案）
 *     final 可附带本轮的结构化元数据（二期前端能力的数据来源）：
 *     - citations    答案引用的检索来源（chunkId/documentId/text）
 *     - confirmation 待确认动作单（T5.3 propose 后等待用户确认；confirmToken
 *                    只随本轮事件发给同一会话客户端，回传时凭 threadId+principal 校验）
 *     - ticket       转人工时创建的工单号（T5.4）
 */

/** 引用来源的对外形状（不含 tenantId——租户身份不向客户端暴露） */
export interface CitationRef {
  chunkId: string;
  documentId: string;
  text: string;
}

/** 待用户确认的动作单（对齐 ActionProposal 的客户端可见子集） */
export interface ConfirmationRequest {
  proposalId: string;
  action: string;
  summary: string;
  params: Record<string, unknown>;
  /** 确认令牌：绑定 proposalId+threadId+principal，过期后回传将被拒绝 */
  confirmToken: string;
  expiresAt: number;
}

/** 转人工建单通知 */
export interface TicketNotice {
  ticketId: string;
}

export interface StreamFinalEvent {
  type: "final";
  answer: string;
  sources: string[];
  citations?: CitationRef[];
  confirmation?: ConfirmationRequest;
  ticket?: TicketNotice;
}

export type StreamReviewMode = "strict" | "chunked" | "async";

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "held"; reason: string }
  | { type: "replace"; reason: string; answer: string }
  | StreamFinalEvent;

/** 段级轻量预检：命中拦截时返回 {ok:false, reason}。默认实现为放行（无规则=不拦） */
export type SegmentPrechecker = (
  segment: string,
  ctx: { context: string },
) => { ok: boolean; reason?: string };

/** 单段最大字符数：超过则强制硬切（避免无标点长段憋住不放） */
export const MAX_SEGMENT_CHARS = 120;

/** 预检拦截后的统一代答（fail-closed：被拦内容绝不回传） */
export const SEGMENT_BLOCKED_REPLY =
  "由于内容安全策略，这条回复的部分内容已被拦截。如需进一步帮助，请回复「转人工」由人工客服跟进。";

const SENTENCE_END = new Set(["。", "！", "？", "；", "!", "?", ";", "\n"]);

/**
 * 在缓冲中找下一个可用切点（排他下标）。
 * 优先最近的句末标点/换行；超过 MAX_SEGMENT_CHARS 时硬切。
 * 返回 -1 表示暂不可切（继续攒）。
 */
export function findSegmentCut(buffer: string, maxChars: number = MAX_SEGMENT_CHARS): number {
  for (let i = 0; i < buffer.length; i += 1) {
    if (SENTENCE_END.has(buffer[i])) return i + 1;
  }
  if (buffer.length >= maxChars) return maxChars;
  return -1;
}

/** 段间携带的上下文窗口（对齐 NeMo context_size 思路，避免跨段语义漏检） */
export function contextWindow(sent: string, size = 80): string {
  return sent.slice(-size);
}
