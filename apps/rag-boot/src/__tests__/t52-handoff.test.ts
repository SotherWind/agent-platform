/**
 * T5.2 交接包（Handoff Package）
 *
 * 依据 Diffco：升级的工单带完整 transcript、结构化账户上下文、已写好的草稿；
 * 人工是在**编辑**而非从零开始。
 *
 * 验收（清单 552 行）：五条全部为硬要求。
 */
import { buildHandoffPackage, evaluateEscalation, type TranscriptEntry } from "../escalation";

const transcript: TranscriptEntry[] = [
  { role: "user", content: "我的订单还没到，手机号 13812345678 可以联系我", at: 1 },
  { role: "assistant", content: "已为你查询订单状态", at: 2 },
  { role: "user", content: "地址：北京市朝阳区某街道 88 号，尽快处理", at: 3 },
];

const decision = evaluateEscalation({ userAskedForHuman: true });

describe("交接包", () => {
  it("包含完整会话 transcript", () => {
    const pkg = buildHandoffPackage({
      threadId: "th-1",
      tenantId: "t",
      transcript,
      draftReply: "草稿",
      decision,
    });

    // 完整：三条都在，角色与顺序保留（脱敏不破坏结构信息，T8.2）
    expect(pkg.transcript).toHaveLength(3);
    expect(pkg.transcript.map((entry) => entry.role)).toEqual(["user", "assistant", "user"]);
    expect(pkg.transcript[1].content).toBe("已为你查询订单状态");
  });

  it("包含结构化账户上下文与已调用工具的结果", () => {
    const pkg = buildHandoffPackage({
      threadId: "th-1",
      tenantId: "t",
      transcript: [],
      accountContext: { plan: "pro", seats: 20, region: "cn-north" },
      toolResults: [
        { name: "get_order_status", kind: "read", ok: true, summary: '{"status":"shipped"}', at: 100 },
      ],
      draftReply: "草稿",
      decision,
    });

    expect(pkg.accountContext).toEqual({ plan: "pro", seats: 20, region: "cn-north" });
    expect(pkg.toolResults).toHaveLength(1);
    expect(pkg.toolResults[0]).toMatchObject({
      name: "get_order_status",
      kind: "read",
      ok: true,
      summary: '{"status":"shipped"}',
    });
  });

  it("包含 Agent 已生成的草稿回复", () => {
    const pkg = buildHandoffPackage({
      threadId: "th-1",
      tenantId: "t",
      transcript: [],
      draftReply: "这是 Agent 已经写好、待人编辑的草稿回复。",
      decision,
    });

    // 人工是在编辑草稿，不是从零开始 —— 草稿必须原样（脱敏后）在场
    expect(pkg.draftReply).toContain("草稿回复");
  });

  it("包含升级原因与触发条件", () => {
    const multi = evaluateEscalation({
      userAskedForHuman: true,
      consecutiveFallbackTurns: 2,
    });
    const pkg = buildHandoffPackage({
      threadId: "th-1",
      tenantId: "t",
      transcript: [],
      draftReply: "草稿",
      decision: multi,
    });

    expect(pkg.triggers).toEqual(expect.arrayContaining(["user_request", "repeated_fallback"]));
    expect(pkg.reasons.length).toBe(multi.triggers.length);
    expect(pkg.reasons.join()).toContain("用户明确要求转人工");
  });

  it("PII 按坐席权限脱敏", () => {
    // masked（默认坐席）：手机号 / 地址脱敏，但保形（前缀与长度保留，排障结构不破坏）
    const masked = buildHandoffPackage({
      threadId: "th-1",
      tenantId: "t",
      transcript,
      draftReply: "回复中含手机号 13812345678。",
      decision,
      clearance: "masked",
    });
    const joined = masked.transcript.map((entry) => entry.content).join("\n");
    expect(joined).not.toContain("13812345678");
    expect(joined).toContain("138****"); // 保形：前缀保留
    expect(masked.draftReply).not.toContain("13812345678");
    expect(masked.piiRedacted).toBe(true);
    // 地址字段同样被处理
    expect(masked.transcript[2].content).not.toContain("88 号");

    // full 权限（如主管坐席）：原文保留，明确标记未脱敏
    const full = buildHandoffPackage({
      threadId: "th-1",
      tenantId: "t",
      transcript,
      draftReply: "草稿",
      decision,
      clearance: "full",
    });
    expect(full.transcript[0].content).toContain("13812345678");
    expect(full.piiRedacted).toBe(false);
  });
});
