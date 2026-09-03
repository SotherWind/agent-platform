/**
 * LLM 抽象（T0.5 依赖倒置 + T6.2 模型分级）
 *
 * 设计约束：
 * - 所有调用点只依赖本接口，测试一律注入 fake，不打真实 API。
 * - 响应必须带回 token 用量，否则 T2.2/T6.3 的预算约束和成本核算无从实现。
 * - 模型名与档位外露，供 T8.1 tracing 记录。
 */

/** Swiggy 的三档：简单模型 / 小推理模型 / 大推理模型 */
export type ModelTier = "simple" | "small" | "large";

export interface LlmRequest {
  /** 系统提示词 */
  system?: string;
  /** 用户侧提示词 */
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  /** 要求严格 JSON 输出（分诊、Reviewer 用） */
  json?: boolean;
  /** 调用阶段，仅用于 tracing 与 fake 路由 */
  stage?: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  tier: ModelTier;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 本次结果是降级产物（T6.1） */
  degraded?: boolean;
  /** 降级前的目标模型名 */
  fallbackFrom?: string;
  /** 所有候选模型均不可用，当前文本是固定兜底话术。 */
  fallbackExhausted?: boolean;
}

export interface Llm {
  readonly model: string;
  readonly tier: ModelTier;
  invoke(req: LlmRequest): Promise<LlmResponse>;
  /** 可选：流式产出文本片段（T9.4） */
  stream?(req: LlmRequest): AsyncIterable<string>;
}

/** 任务类型 → 模型档位（T6.2） */
export type LlmTask =
  | "triage"
  | "rewrite"
  | "specialist"
  | "orchestrate"
  | "generate"
  | "review";
