/**
 * T3.1 工具契约与读写分级
 *
 * 依据：
 * - 验证文档「读写工具分级」+「写操作授权只取会话层身份」
 * - Diffco：严格工具边界——爆炸半径由工具清单限死
 *
 * 关键设计：工具边界与写权限在**执行前由代码校验**，不依赖模型自觉（清单 264 行）。
 * 提示词里写「你只能调用 X」是建议，这里的 `kind` / `requiresConfirmation` 才是约束。
 */
import { z } from "zod/v4";
import { GuardrailBlockedError, ToolExecutionError } from "../errors";
import { createHash } from "node:crypto";
import type { IdempotencyTicket } from "./idempotency";

export type ToolKind = "read" | "write";

/** 凭证分读写两项配置，读工具与写工具不共用权限（清单 386 行） */
export interface ToolCredential {
  read?: string;
  write?: string;
}

/** 工具执行上下文：租户身份只来自会话层，不由模型传入 */
export interface ToolContext {
  tenantId: string;
  threadId: string;
  /** 会话身份（人或系统标识），写操作审计归因用 */
  principal: string;
  /** 当前轮次，参与幂等键计算 */
  turnIndex: number;
  /** 幂等存储（T3.2） */
  idempotency: {
    begin<T>(key: string): Promise<IdempotencyTicket<T>>;
  };
  /** 审计日志（T4.2 / T8.2） */
  audit: (entry: AuditEntry) => void;
  /** write 类工具必须携带的有效确认令牌，否则拒绝执行 */
  confirmToken?: string;
  confirmationProposalId?: string;
  verifyConfirmation?: (request: ConfirmationCheck) => { idempotencyKey: string } | null;
  /** Stable downstream operation identity; business backends must honor it for writes. */
  operationKey?: string;
  clock?: () => number;
}

export interface ConfirmationCheck {
  proposalId: string;
  token: string;
  toolName: string;
  args: unknown;
  tenantId: string;
  threadId: string;
  principal: string;
}

export interface AuditEntry {
  at: number;
  tenantId: string;
  threadId: string;
  principal: string;
  tool: string;
  kind: ToolKind;
  /** 幂等键，重发可关联到同一条记录 */
  idempotencyKey: string;
  outcome: "executed" | "deduped" | "blocked";
  reasonCode?: string;
  detail?: string;
}

export interface AgentTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** 读 / 写分级 */
  kind: ToolKind;
  /** 参数 schema */
  schema: z.ZodType;
  /** 工具清单边界：该工具归属的业务域，供 T1.3 专家隔离校验 */
  domains: string[];
  /** 写工具必须声明 requiresConfirmation（由 assertToolContract 强制） */
  requiresConfirmation?: boolean;
  /** 是否幂等。写工具必须幂等，否则重发会产生重复副作用 */
  idempotent: boolean;
  credential: ToolCredential;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * 工具契约静态校验。
 *
 * 违反点：
 * - write 工具必须声明 requiresConfirmation → 否则「未确认就改状态」的路径会悄悄存在
 * - write 工具必须声明 idempotent → MCP 2026-07-28 后为协议级要求（T3.2）
 * - 写工具必须配置写凭证，读工具必须配置读凭证 → 读写不共用权限
 */
export function assertToolContract(tool: AgentTool<any, any>): void {
  if (!tool.name) throw new Error("tool.name is required");
  if (tool.kind !== "read" && tool.kind !== "write") {
    throw new Error(`tool "${tool.name}" has invalid kind: ${String(tool.kind)}`);
  }
  if (tool.kind === "write") {
    if (!tool.requiresConfirmation) {
      throw new Error(
        `write tool "${tool.name}" must declare requiresConfirmation: true (T3.1)`,
      );
    }
    if (!tool.idempotent) {
      throw new Error(
        `write tool "${tool.name}" must be idempotent (T3.2 / MCP 2026-07-28)`,
      );
    }
    if (!tool.credential.write) {
      throw new Error(
        `write tool "${tool.name}" must declare credential.write (read/write credentials must differ)`,
      );
    }
  } else if (!tool.credential.read) {
    throw new Error(`read tool "${tool.name}" must declare credential.read`);
  }
}

/** 批量校验工具注册表，优先暴露第一个违规项 */
export function assertToolRegistry(tools: Array<AgentTool<any, any>>): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    seen.add(tool.name);
    assertToolContract(tool);
  }
}

export interface ExecutionResult<O> {
  ok: boolean;
  result?: O;
  /** 命中幂等缓存：副作用只发生了一次 */
  deduped: boolean;
  idempotencyKey: string;
  blockedReason?: string;
  reasonCode?: string;
}

export function parseToolInput(tool: AgentTool<any, any>, rawInput: unknown): unknown {
  // Identity fields are never model-controlled, including for custom schemas.
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? Object.fromEntries(Object.entries(rawInput).filter(([key]) =>
        !["tenantId", "principal", "threadId", "confirmToken", "authContext"].includes(key)))
    : rawInput;
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolExecutionError(`tool "${tool.name}" invalid input: ${parsed.error.message}`, {
      stage: "tools", retryable: false,
    });
  }
  return parsed.data;
}

/**
 * 工具执行入口：所有调用都必须经过这里。
 *
 * 顺序：
 * 1. 参数校验（schema）
 * 2. 写工具未确认 → GuardrailBlockedError，绝不执行
 * 3. 幂等：同 key 命中缓存则直接返回，不产生第二次副作用
 * 4. 真正执行 + 审计
 */
export async function executeTool<I, O>(
  tool: AgentTool<I, O>,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ExecutionResult<O>> {
  assertToolContract(tool);
  if (!ctx.tenantId?.trim() || !ctx.principal?.trim() || !ctx.threadId?.trim()) {
    throw new GuardrailBlockedError("Tool execution requires a complete session identity.", {
      stage: "tools", reasonCode: "missing_principal",
    });
  }
  const parsed = parseToolInput(tool, rawInput);

  let idempotencyKey = toolIdempotencyKey({
    tenantId: ctx.tenantId,
    principal: ctx.principal,
    threadId: ctx.threadId,
    toolName: tool.name,
    args: parsed,
    turnIndex: ctx.turnIndex,
  });

  const now = ctx.clock ?? Date.now;

  // 写工具必须持有确认令牌（T5.3 的代码级保证：不存在「LLM 输出直接触发写操作」的路径）
  const confirmation = tool.kind === "write" && ctx.confirmToken && ctx.confirmationProposalId
    ? ctx.verifyConfirmation?.({
        proposalId: ctx.confirmationProposalId, token: ctx.confirmToken,
        toolName: tool.name, args: parsed,
        tenantId: ctx.tenantId, threadId: ctx.threadId, principal: ctx.principal,
      })
    : null;
  if (tool.kind === "write" && !confirmation) {
    ctx.audit({
      at: now(),
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      principal: ctx.principal,
      tool: tool.name,
      kind: tool.kind,
      idempotencyKey,
      outcome: "blocked",
      reasonCode: "confirmation_required",
      detail: "write tool invoked without a valid confirm token",
    });
    throw new GuardrailBlockedError(
      `Write tool "${tool.name}" requires a confirmed proposal before execution.`,
      { stage: "tools", reasonCode: "confirmation_required" },
    );
  }
  if (confirmation) idempotencyKey = confirmation.idempotencyKey;

  // 幂等：重发命中缓存，副作用只发生一次（T3.2）
  const ticket = await ctx.idempotency.begin<O>(idempotencyKey);
  if (ticket.hit) {
    ctx.audit({
      at: now(),
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      principal: ctx.principal,
      tool: tool.name,
      kind: tool.kind,
      idempotencyKey,
      outcome: "deduped",
    });
    return { ok: true, result: ticket.result, deduped: true, idempotencyKey };
  }

  let leaseError: unknown;
  const heartbeat = ticket.renew
    ? setInterval(() => {
        void ticket.renew!().catch((error) => { leaseError = error; });
      }, Math.max(1, Math.floor((ticket.leaseMs ?? 60_000) / 3)))
    : undefined;
  heartbeat?.unref();
  try {
    const result = await tool.execute(parsed as I, { ...ctx, operationKey: idempotencyKey });
    if (leaseError) throw leaseError;
    await ticket.commit(result);
    ctx.audit({
      at: now(),
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      principal: ctx.principal,
      tool: tool.name,
      kind: tool.kind,
      idempotencyKey,
      outcome: "executed",
    });
    return { ok: true, result, deduped: false, idempotencyKey };
  } catch (err) {
    await ticket.rollback?.();
    const isAgentError = err instanceof Error && err.name.includes("Error");
    const error =
      err instanceof Error && isAgentError
        ? err
        : new ToolExecutionError(
            `tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            { stage: "tools", cause: err },
          );
    ctx.audit({
      at: now(),
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      principal: ctx.principal,
      tool: tool.name,
      kind: tool.kind,
      idempotencyKey,
      outcome: "blocked",
      reasonCode: "execution_failed",
      detail: error.message,
    });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/**
 * 幂等键 = hash(threadId + toolName + 归一化参数 + turnIndex)
 *
 * 归一化：对象 key 排序后稳定序列化，避免 {"a":1,"b":2} 与 {"b":2,"a":1} 算成两个 key。
 */
export function toolIdempotencyKey(parts: {
  tenantId?: string;
  principal?: string;
  threadId: string;
  toolName: string;
  args: unknown;
  turnIndex: number;
}): string {
  return createHash("sha256").update(stableStringify([
    parts.tenantId ?? "", parts.principal ?? "", parts.threadId,
    parts.toolName, parts.args, parts.turnIndex,
  ])).digest("hex");
}

/** 稳定序列化：对象键递归排序 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a 64 位（用 BigInt 实现，避免引入额外依赖） */
export function hashString(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
