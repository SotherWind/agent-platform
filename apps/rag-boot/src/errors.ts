/**
 * T0.3 领域错误模型。
 *
 * 设计约束：
 * - 降级逻辑（T6.1）只能凭 `retryable` 决策，不靠字符串匹配错误信息。
 * - 每个错误携带 `stage` 与 `traceId`，供 tracing 归因（T8.1）。
 */

export interface AgentErrorOptions {
  stage?: string;
  traceId?: string;
  cause?: unknown;
}

/** 领域错误基类：所有可被降级链识别的错误都必须继承自它 */
export class AgentError extends Error {
  /** 是否可重试：降级链仅凭此字段决策 */
  readonly retryable: boolean;
  /** 错误发生的阶段，如 triage / retrieve / generate / review */
  readonly stage: string;
  /** 全链路追踪 ID */
  readonly traceId?: string;

  constructor(
    message: string,
    options: AgentErrorOptions & { retryable: boolean; stage: string },
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.retryable = options.retryable;
    this.stage = options.stage;
    this.traceId = options.traceId;
  }
}

/** 租户缺失 / 非法：fail-closed，不可重试 */
export class TenantMissingError extends AgentError {
  constructor(message = "tenantId is required. Request rejected.", options: AgentErrorOptions = {}) {
    super(message, { ...options, retryable: false, stage: options.stage ?? "triage" });
  }
}

/** 受信身份上下文缺失或与会话绑定不一致：fail-closed */
export class AuthenticationContextError extends TenantMissingError {
  readonly reasonCode: string;

  constructor(
    message = "A trusted authentication context is required.",
    options: AgentErrorOptions & { reasonCode?: string } = {},
  ) {
    super(message, { ...options, stage: options.stage ?? "access" });
    this.reasonCode = options.reasonCode ?? "authentication_context_invalid";
  }
}

/** Guardrails 拦截：输入/动作/输出三点命中后的统一错误 */
export class GuardrailBlockedError extends AgentError {
  /** 拦截原因码，供审计日志（T4.2）使用 */
  readonly reasonCode: string;

  constructor(message: string, options: AgentErrorOptions & { reasonCode?: string } = {}) {
    super(message, { ...options, retryable: false, stage: options.stage ?? "guardrails" });
    this.reasonCode = options.reasonCode ?? "guardrail_blocked";
  }
}

/** 工具执行失败：默认可重试（幂等键保证重发安全，见 T3.2） */
export class ToolExecutionError extends AgentError {
  constructor(message: string, options: AgentErrorOptions & { retryable?: boolean } = {}) {
    super(message, { ...options, retryable: options.retryable ?? true, stage: options.stage ?? "tools" });
  }
}

/** LLM 调用失败 / 超时：可重试（降级链可切换备用模型，见 T6.1） */
export class LlmTimeoutError extends AgentError {
  constructor(message = "LLM invocation failed or timed out.", options: AgentErrorOptions = {}) {
    super(message, { ...options, retryable: true, stage: options.stage ?? "generate" });
  }
}

/** LLM 配置缺失（如未配置 API key）：不可重试，配置问题 */
export class LlmConfigError extends AgentError {
  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, { ...options, retryable: false, stage: options.stage ?? "generate" });
  }
}

/** 预算超限（token / 轮次）：终止循环，不可重试 */
export class BudgetExceededError extends AgentError {
  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, { ...options, retryable: false, stage: options.stage ?? "orchestrate" });
  }
}

/** 需要转人工：不是故障，是受控升级 */
export class EscalationRequiredError extends AgentError {
  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, { ...options, retryable: false, stage: options.stage ?? "escalate" });
  }
}

/** 把任意未知错误归一为 AgentError：保住 retryable 决策能力 */
export function toAgentError(err: unknown, fallbackStage = "unknown"): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LlmTimeoutError(message, { stage: fallbackStage, cause: err });
}
