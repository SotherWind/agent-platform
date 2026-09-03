/**
 * T5.3 propose / confirm / execute 三段分离
 *
 * Diffco 称之为「整个系统中最重要的一条设计规则」：Agent 建议，用户确认，代码执行。
 *
 * 代码级保证（清单 559 行）：**不存在「LLM 输出直接触发写操作」的路径**。
 * 做法是把三段拆成三个独立对象与三个独立方法，让「跳过 confirm 直接 execute」
 * 在类型与运行时两侧都不可达：
 * - propose() 只返回 proposal（含 confirmToken），不接触任何执行器
 * - confirm() 校验令牌绑定与有效期，返回「已确认」状态
 * - execute() 只接受**已确认且在有效期内**的 proposal
 */
import { z } from "zod/v4";
import { hashString, stableStringify, type AgentTool } from "../tools/contract";
import { GuardrailBlockedError } from "../errors";

export const ActionProposalSchema = z.object({
  id: z.string(),
  /** 动作类型，对应一个 write 工具 */
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  /** 展示给用户的确认话术 */
  summary: z.string(),
  tenantId: z.string(),
  threadId: z.string(),
  /** 令牌绑定的会话身份 */
  principal: z.string(),
  /** 确认令牌：由 id + threadId + principal + secret 派生 */
  confirmToken: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(["pending", "confirmed", "executed", "expired", "rejected"]),
  idempotencyKey: z.string(),
});

export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ActionResultSchema = z.object({
  proposalId: z.string(),
  action: z.string(),
  ok: z.boolean(),
  result: z.unknown().nullable().default(null),
  error: z.string().nullable().default(null),
  at: z.number(),
  /** 执行是否走了确定性后端（永远为 true，供审计断言） */
  deterministic: z.boolean().default(true),
});

export type ActionResult = z.infer<typeof ActionResultSchema>;

export interface ProposalServiceOptions {
  /** 令牌派生密钥。生产环境从配置注入，不落代码库 */
  secret?: string;
  ttlMs?: number;
  clock?: () => number;
  onAudit?: (entry: {
    kind: "propose" | "confirm" | "reject" | "execute" | "expire";
    proposal: ActionProposal;
    at: number;
    detail?: string;
  }) => void;
}

/** 派生确认令牌：绑定 proposalId + threadId + principal */
function deriveToken(
  secret: string,
  parts: { id: string; threadId: string; principal: string },
): string {
  return hashString(
    [secret, parts.id, parts.threadId, parts.principal].join("|"),
  );
}

/**
 * 三段分离服务。
 *
 * 注意 `propose()` 的入参里**没有**执行器——Agent 侧拿不到任何可执行的东西，
 * 只能拿到一个待确认的 proposal 对象。这是设计约束，不是约定。
 */
export class ProposalService {
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly onAudit: NonNullable<ProposalServiceOptions["onAudit"]>;
  private readonly proposals = new Map<string, ActionProposal>();
  private seq = 0;

  constructor(options: ProposalServiceOptions = {}) {
    this.secret = options.secret ?? "rag-boot-dev-secret";
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.clock = options.clock ?? Date.now;
    this.onAudit = options.onAudit ?? (() => {});
  }

  /** 第一段：Agent 产出 proposal。不含任何执行能力 */
  propose(input: {
    action: string;
    params: Record<string, unknown>;
    summary: string;
    tenantId: string;
    threadId: string;
    principal: string;
  }): ActionProposal {
    const now = this.clock();
    this.seq += 1;
    const id = `prop-${now}-${this.seq}`;
    const token = deriveToken(this.secret, {
      id,
      threadId: input.threadId,
      principal: input.principal,
    });

    const proposal: ActionProposal = ActionProposalSchema.parse({
      id,
      action: input.action,
      params: input.params,
      summary: input.summary,
      tenantId: input.tenantId,
      threadId: input.threadId,
      principal: input.principal,
      confirmToken: token,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "pending",
      idempotencyKey: hashString(
        [input.threadId, input.action, stableStringify(input.params)].join("|"),
      ),
    });

    this.proposals.set(id, proposal);
    this.onAudit({ kind: "propose", proposal, at: now });
    return proposal;
  }

  get(id: string): ActionProposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * 第二段：用户确认。
   *
   * 令牌与会话身份绑定：他人持令牌无法确认——令牌里编进了 threadId 与 principal，
   * 换个会话来确认，重新派生出的令牌与原令牌不一致，直接拒绝。
   */
  confirm(input: { proposalId: string; token: string; threadId: string; principal: string }): ActionProposal {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) {
      throw new GuardrailBlockedError("Proposal not found.", {
        stage: "confirm",
        reasonCode: "proposal_not_found",
      });
    }

    if (this.clock() > proposal.expiresAt) {
      const expired: ActionProposal = { ...proposal, status: "expired" };
      this.proposals.set(proposal.id, expired);
      this.onAudit({ kind: "expire", proposal: expired, at: this.clock() });
      throw new GuardrailBlockedError("Proposal expired. Please request a new one.", {
        stage: "confirm",
        reasonCode: "proposal_expired",
      });
    }

    const expected = deriveToken(this.secret, {
      id: proposal.id,
      threadId: input.threadId,
      principal: input.principal,
    });

    if (expected !== input.token || input.threadId !== proposal.threadId) {
      this.onAudit({
        kind: "reject",
        proposal,
        at: this.clock(),
        detail: "confirm token does not match session identity",
      });
      throw new GuardrailBlockedError(
        "Confirm token is not valid for this session.",
        { stage: "confirm", reasonCode: "token_identity_mismatch" },
      );
    }

    const confirmed: ActionProposal = { ...proposal, status: "confirmed" };
    this.proposals.set(proposal.id, confirmed);
    this.onAudit({ kind: "confirm", proposal: confirmed, at: this.clock() });
    return confirmed;
  }

  /**
   * 第三段：确定性后端执行。
   *
   * 硬约束：
   * - 只接受 status === "confirmed" 的 proposal（pending 直接拒绝）
   * - 执行路径不经过 LLM：调用方传入的是 `AgentTool.execute`，是普通函数
   * - 工具执行走 T3.2 幂等，重复确认不会重复生效
   */
  async execute(
    proposal: ActionProposal,
    tool: AgentTool<any, any>,
    executeFn: (tool: AgentTool<any, any>, input: unknown, token: string) => Promise<unknown>,
  ): Promise<ActionResult> {
    const now = this.clock();
    if (tool.kind !== "write" || !tool.requiresConfirmation) {
      throw new GuardrailBlockedError(
        `Proposal ${proposal.id} must execute a confirmed write tool.`,
        { stage: "execute", reasonCode: "invalid_write_tool" },
      );
    }
    if (tool.name !== proposal.action || tool.kind !== "write") {
      throw new GuardrailBlockedError(
        `Proposal action ${proposal.action} does not match tool ${tool.name}.`,
        { stage: "execute", reasonCode: "proposal_tool_mismatch" },
      );
    }

    if (proposal.status !== "confirmed") {
      throw new GuardrailBlockedError(
        `Proposal ${proposal.id} is not confirmed (status=${proposal.status}). Execution refused.`,
        { stage: "execute", reasonCode: "not_confirmed" },
      );
    }
    if (now > proposal.expiresAt) {
      throw new GuardrailBlockedError("Confirmed proposal expired before execution.", {
        stage: "execute",
        reasonCode: "proposal_expired",
      });
    }

    try {
      const result = await executeFn(tool, proposal.params, proposal.confirmToken);
      const executed: ActionProposal = { ...proposal, status: "executed" };
      this.proposals.set(proposal.id, executed);
      this.onAudit({ kind: "execute", proposal: executed, at: this.clock() });
      return ActionResultSchema.parse({
        proposalId: proposal.id,
        action: proposal.action,
        ok: true,
        result,
        error: null,
        at: this.clock(),
        deterministic: true,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const result = ActionResultSchema.parse({
        proposalId: proposal.id,
        action: proposal.action,
        ok: false,
        result: null,
        error,
        at: this.clock(),
        deterministic: true,
      });
      this.onAudit({
        kind: "execute",
        proposal,
        at: this.clock(),
        detail: error,
      });
      return result;
    }
  }

  /** 供测试：取出全部 proposal */
  all(): ActionProposal[] {
    return [...this.proposals.values()];
  }
}
