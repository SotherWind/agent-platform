/**
 * T9.1 渠道适配层。
 *
 * 渠道层只做归一化，不参与分诊、检索或生成。这样企微、微信客服、千牛、网页和
 * 电话 ASR 的差异都被吸收在入口，编排层只接收 InboundMessage。
 *
 * 安全边界：tenantId / principal 必须由接入层鉴权结果传入，永远不从渠道 payload 读取。
 * rawPayload 只用于排障，调用 toGraphInput() 时会被明确丢弃，不进入 LLM 上下文。
 */
import {
  InboundMessageSchema,
  type InboundAttachment,
  type InboundMessage,
} from "./schema";

export type SupportedChannel =
  | "web"
  | "wechat_work"
  | "wechat_customer_service"
  | "qianniu"
  | "phone_asr";

export type AttachmentRoute = "multimodal" | "knowledge_ingest" | "asr" | "reject";

export interface NormalizedAttachment extends InboundAttachment {
  route: AttachmentRoute;
  reason?: string;
}

export interface ChannelAdapterContext {
  tenantId: string;
  principal: string;
  threadId?: string;
  clock?: () => number;
}

export interface ChannelAdapter {
  readonly channel: SupportedChannel;
  normalize(payload: Record<string, unknown>, context: ChannelAdapterContext): InboundMessage;
}

export class UnknownChannelError extends Error {
  readonly code = "unknown_channel";

  constructor(channel: string) {
    super(`Unknown channel type: ${channel}`);
    this.name = "UnknownChannelError";
  }
}

export class UnsupportedAttachmentError extends Error {
  readonly code = "unsupported_attachment";
  readonly attachmentType: string;

  constructor(attachmentType: string) {
    super(`Unsupported attachment type: ${attachmentType}`);
    this.name = "UnsupportedAttachmentError";
    this.attachmentType = attachmentType;
  }
}

function stringValue(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function arrayValue(payload: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function routeAttachment(type: string): { route: AttachmentRoute; reason?: string } {
  switch (type) {
    case "image":
      return { route: "multimodal" };
    case "document":
      return { route: "knowledge_ingest" };
    case "audio":
      return { route: "asr" };
    case "video":
    case "other":
    default:
      return { route: "reject", reason: "仅支持图片、文档和电话音频附件" };
  }
}

function normalizeAttachments(payload: Record<string, unknown>): NormalizedAttachment[] {
  return arrayValue(payload, "attachments", "files").map((raw) => {
    const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const rawType = stringValue(value, "type", "kind").toLowerCase();
    const mimeType = stringValue(value, "mimeType", "mime", "contentType");
    const type: InboundAttachment["type"] =
      rawType === "image" || mimeType.startsWith("image/")
        ? "image"
        : rawType === "document" || rawType === "file" || mimeType.includes("pdf") || mimeType.includes("word")
          ? "document"
          : rawType === "audio" || mimeType.startsWith("audio/")
            ? "audio"
            : rawType === "video" || mimeType.startsWith("video/")
              ? "video"
              : "other";
    const routed = routeAttachment(type);
    return {
      type,
      mimeType,
      url: stringValue(value, "url", "downloadUrl", "path"),
      transcript: stringValue(value, "transcript") || null,
      transcriptConfidence:
        typeof value.transcriptConfidence === "number" ? value.transcriptConfidence : null,
      sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0,
      ...routed,
    } as NormalizedAttachment;
  });
}

function normalizePayload(
  channel: SupportedChannel,
  payload: Record<string, unknown>,
  context: ChannelAdapterContext,
): InboundMessage {
  const messageId = stringValue(payload, "messageId", "message_id", "id", "msgId");
  const text = stringValue(payload, "text", "content", "query", "message", "transcript");
  const threadId =
    context.threadId ??
    (stringValue(payload, "threadId", "thread_id", "conversationId", "conversation_id") || messageId);
  const receivedAt =
    typeof payload.receivedAt === "number"
      ? payload.receivedAt
      : typeof payload.timestamp === "number"
        ? payload.timestamp
        : (context.clock ?? Date.now)();
  const attachments = normalizeAttachments(payload);

  return InboundMessageSchema.parse({
    channel,
    messageId: messageId || `${channel}-${receivedAt}`,
    tenantId: context.tenantId,
    threadId,
    principal: context.principal,
    text,
    attachments,
    meta: {
      ...(payload.meta && typeof payload.meta === "object" ? (payload.meta as Record<string, unknown>) : {}),
      attachmentRoutes: attachments.map((attachment) => attachment.route),
    },
    rawPayload: { ...payload },
    receivedAt,
  });
}

class DefaultChannelAdapter implements ChannelAdapter {
  constructor(public readonly channel: SupportedChannel) {}

  normalize(payload: Record<string, unknown>, context: ChannelAdapterContext): InboundMessage {
    return normalizePayload(this.channel, payload, context);
  }
}

export const DEFAULT_CHANNELS: SupportedChannel[] = [
  "web",
  "wechat_work",
  "wechat_customer_service",
  "qianniu",
  "phone_asr",
];

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(adapters: ChannelAdapter[] = DEFAULT_CHANNELS.map((channel) => new DefaultChannelAdapter(channel))) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  normalize(
    channel: string,
    payload: Record<string, unknown>,
    context: ChannelAdapterContext,
  ): InboundMessage {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new UnknownChannelError(channel);
    return adapter.normalize(payload, context);
  }

  has(channel: string): boolean {
    return this.adapters.has(channel);
  }
}

export const defaultChannelRegistry = new ChannelRegistry();

export function normalizeInboundMessage(
  channel: string,
  payload: Record<string, unknown>,
  context: ChannelAdapterContext,
): InboundMessage {
  return defaultChannelRegistry.normalize(channel, payload, context);
}

/**
 * 生成给编排层的最小输入。这里显式不带 rawPayload 和渠道扩展字段，防止排障数据
 * 意外进入模型上下文。
 */
export function toGraphInput(message: InboundMessage): {
  query: string;
  tenantId: string;
  threadId: string;
  principal: string;
  /** ASR 渠道的转写置信度，非 ASR 渠道为 null */
  transcriptConfidence: number | null;
} {
  const rejected = message.attachments.filter((attachment) => attachment.route === "reject");
  if (rejected.length > 0) {
    throw new UnsupportedAttachmentError(rejected[0].type);
  }
  return {
    query: message.text,
    tenantId: message.tenantId,
    threadId: message.threadId,
    principal: message.principal,
    transcriptConfidence: transcriptConfidenceOf(message),
  };
}

export function attachmentRoutes(message: InboundMessage): Array<{
  type: InboundAttachment["type"];
  route: AttachmentRoute;
}> {
  return message.attachments.map((attachment) => ({ type: attachment.type, route: attachment.route }));
}

/**
 * 取本条消息的 ASR 转写置信度，多条语音附件取**最低**的一条。
 *
 * 非 ASR 渠道（或渠道没给置信度）返回 null——这时不应参与 T2.4 的置信度计算，
 * 用 1.0 兜底是错的，那等于假装文本渠道的转写是完美的。
 *
 * 取最低而非平均：用户说了三句话，只要有一句没听清，整通电话的语义就是可疑的。
 */
export function transcriptConfidenceOf(message: InboundMessage): number | null {
  const confidences = message.attachments
    .map((attachment) => attachment.transcriptConfidence)
    .filter((value): value is number => typeof value === "number");
  if (confidences.length === 0) return null;
  return Math.min(...confidences);
}
