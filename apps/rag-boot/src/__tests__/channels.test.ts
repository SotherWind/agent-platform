import {
  ChannelRegistry,
  UnknownChannelError,
  UnsupportedAttachmentError,
  attachmentRoutes,
  toGraphInput,
  normalizeInboundMessage,
} from "../channels";

describe("渠道适配", () => {
  it("把消息归一化并保留附件 route", () => {
    const message = normalizeInboundMessage(
      "web",
      {
        id: "m-1",
        content: "请看这个文件",
        attachments: [
          { type: "image", mime: "image/png", url: "https://invalid.local/image.png" },
          { type: "document", mime: "application/pdf", url: "https://invalid.local/a.pdf" },
          { type: "audio", mime: "audio/wav", transcript: "转写内容" },
        ],
        tenantId: "spoofed-tenant",
        rawSecret: "must-not-enter-graph",
      },
      { tenantId: "tenant-a", principal: "user-a" },
    );

    expect(message.tenantId).toBe("tenant-a");
    expect(attachmentRoutes(message)).toEqual([
      { type: "image", route: "multimodal" },
      { type: "document", route: "knowledge_ingest" },
      { type: "audio", route: "asr" },
    ]);
    expect(message.rawPayload).toHaveProperty("rawSecret");
    expect(toGraphInput(message)).not.toHaveProperty("rawPayload");
    expect(toGraphInput(message)).not.toHaveProperty("attachments");
  });

  it("未知渠道被拒绝，不回退到默认渠道", () => {
    expect(() => new ChannelRegistry().normalize("unknown", {}, {
      tenantId: "tenant-a",
      principal: "user-a",
    })).toThrow(UnknownChannelError);
  });

  it("不支持的附件路由为 reject，并在进入 graph 前拒绝", () => {
    const message = normalizeInboundMessage(
      "web",
      { id: "m-2", attachments: [{ type: "video", url: "https://invalid.local/a.mp4" }] },
      { tenantId: "tenant-a", principal: "user-a" },
    );

    expect(attachmentRoutes(message)).toEqual([{ type: "video", route: "reject" }]);
    expect(() => toGraphInput(message)).toThrow(UnsupportedAttachmentError);
  });
});
