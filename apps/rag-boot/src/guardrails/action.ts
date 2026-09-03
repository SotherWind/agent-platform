/**
 * T4.2 动作侧 Guardrails（三点里最关键的一道）
 *
 * Agentforce 的三点 guardrails 中，动作侧是唯一能拦住「真实世界副作用」的一道：
 * 输入侧拦的是话术，输出侧拦的是话术，动作侧拦的是**钱和状态**。
 *
 * 依据验证文档：写操作授权只取会话层身份。所以这里的校验全部基于
 * ToolContext 里的会话身份，绝不采信模型输出里声称的身份。
 */
import { z } from "zod/v4";
import { GuardrailBlockedError } from "../errors";

export type ActionGuardrailCode =
  | "tool_not_in_allowlist"
  | "account_mismatch"
  | "amount_threshold"
  | "missing_principal"
  | "confirmation_required"
  | "write_in_readonly_mode";

export const ActionGuardrailCodeLabel: Record<ActionGuardrailCode, string> = {
  tool_not_in_allowlist: "动作超出当前专家的工具清单",
  account_mismatch: "动作作用于非当前会话身份的账户",
  amount_threshold: "金额超出自动处理阈值，需人工审批",
  missing_principal: "会话身份缺失，无法授权写操作",
  confirmation_required: "写操作缺少用户确认",
  write_in_readonly_mode: "只读模式下禁止写操作",
};

export const ActionGuardrailRequestSchema = z.object({
  /** 提议调用的工具名 */
  toolName: z.string(),
  kind: z.enum(["read", "write"]),
  /** 当前专家被授权的工具清单（T1.3） */
  allowlist: z.array(z.string()).default(() => []),
  /** 动作作用的目标账户 */
  targetAccount: z.string().optional(),
  /** 会话身份绑定的账户 */
  sessionAccount: z.string().optional(),
  /** 会话身份（principal） */
  principal: z.string().optional(),
  /** 动作涉及的金额（分） */
  amountCents: z.number().optional(),
  /** 是否已获得用户确认 */
  confirmed: z.boolean().default(false),
});

export type ActionGuardrailRequest = z.infer<typeof ActionGuardrailRequestSchema>;

export type ActionGuardrailVerdict =
  | { allowed: true; code: null; reason: null }
  | { allowed: false; code: ActionGuardrailCode; reason: string };

export interface ActionGuardrailOptions {
  /** 金额阈值（分）。超过则强制人工审批 */
  amountThresholdCents?: number;
  /** 只读模式：禁止一切写操作（灰度 / 高危租户 / 演练环境） */
  readOnlyMode?: boolean;
  /** 审计：拦截结果必须带原因码入日志（清单 493 行） */
  audit?: (entry: {
    at: number;
    code: ActionGuardrailCode | null;
    allowed: boolean;
    toolName: string;
    detail: string;
    principal?: string;
  }) => void;
  clock?: () => number;
}

/**
 * 动作侧 Guardrails。
 *
 * 校验顺序刻意固定：清单 → 身份 → 金额 → 确认。
 * 先查清单是因为它最便宜也最硬（工具都不在清单里，后面几项没有讨论余地）。
 */
export class ActionGuardrails {
  private readonly amountThresholdCents: number;
  private readonly readOnlyMode: boolean;
  private readonly audit: NonNullable<ActionGuardrailOptions["audit"]>;
  private readonly clock: () => number;

  constructor(options: ActionGuardrailOptions = {}) {
    this.amountThresholdCents = options.amountThresholdCents ?? 200_00;
    this.readOnlyMode = options.readOnlyMode ?? false;
    this.audit = options.audit ?? (() => {});
    this.clock = options.clock ?? Date.now;
  }

  check(raw: ActionGuardrailRequest): ActionGuardrailVerdict {
    const req = ActionGuardrailRequestSchema.parse(raw);

    // 1) 工具清单边界：爆炸半径由清单限死（Diffco）
    if (req.allowlist.length > 0 && !req.allowlist.includes(req.toolName)) {
      return this.deny(req, "tool_not_in_allowlist");
    }

    // 2) 只读模式：先于身份校验，避免为必然被拒的动作去做昂贵的身份查询
    if (this.readOnlyMode && req.kind === "write") {
      return this.deny(req, "write_in_readonly_mode");
    }

    // 3) 账户归属：动作只能作用于当前会话身份绑定的账户
    if (
      req.targetAccount !== undefined &&
      req.sessionAccount !== undefined &&
      req.targetAccount !== req.sessionAccount
    ) {
      return this.deny(req, "account_mismatch");
    }

    // 4) 写操作必须有会话身份
    if (req.kind === "write" && !req.principal) {
      return this.deny(req, "missing_principal");
    }

    // 5) 金额阈值：超限强制人工审批
    if (
      req.amountCents !== undefined &&
      this.amountThresholdCents > 0 &&
      req.amountCents > this.amountThresholdCents
    ) {
      return this.deny(req, "amount_threshold");
    }

    // 6) 写操作必须已确认（T5.3 的第二道闸；第一道在 executeTool）
    if (req.kind === "write" && !req.confirmed) {
      return this.deny(req, "confirmation_required");
    }

    this.audit({
      at: this.clock(),
      code: null,
      allowed: true,
      toolName: req.toolName,
      detail: "allowed",
      principal: req.principal,
    });
    return { allowed: true, code: null, reason: null };
  }

  /** 严格模式：拦截即抛错，错误自带原因码 */
  assert(raw: ActionGuardrailRequest): void {
    const verdict = this.check(raw);
    if (!verdict.allowed) {
      throw new GuardrailBlockedError(
        `${ActionGuardrailCodeLabel[verdict.code]}：${verdict.reason}`,
        { stage: "guardrails", reasonCode: verdict.code },
      );
    }
  }

  private deny(
    req: ActionGuardrailRequest,
    code: ActionGuardrailCode,
  ): ActionGuardrailVerdict {
    const reason = ActionGuardrailCodeLabel[code];
    this.audit({
      at: this.clock(),
      code,
      allowed: false,
      toolName: req.toolName,
      detail: reason,
      principal: req.principal,
    });
    return { allowed: false, code, reason };
  }
}

/** 便捷函数：给工具调用包一层动作侧校验，拦截即抛错 */
export function guardToolCall(
  guardrails: ActionGuardrails,
  req: ActionGuardrailRequest,
): void {
  guardrails.assert(req);
}
