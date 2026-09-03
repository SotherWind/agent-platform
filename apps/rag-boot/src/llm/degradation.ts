/**
 * T6.1 降级链 + T6.2 模型分级
 *
 * 核心约束（清单 603 行）：系统在任何单点故障下**仍有响应**——
 * 可以答得不够好，不能没有响应。
 */

import { AgentError, LlmTimeoutError } from "../errors";
import type { Llm, LlmRequest, LlmResponse, LlmTask, ModelTier } from "./types";

/** 降级事件，供 T8.1 观测 */
export interface DegradationEvent {
  from: string;
  to: string | null;
  reason: string;
  retryable: boolean;
}

export interface DegradationObserver {
  (event: DegradationEvent): void;
}

export interface FallbackChainOptions {
  /** 降级事件观测点 */
  onDegrade?: DegradationObserver;
  /** 最大重试次数（在**同一**模型上重试，处理瞬时抖动） */
  maxRetries?: number;
  /** 全部模型耗尽时的兜底话术 */
  fallbackText?: string;
}

/**
 * 把多个 LLM 串成降级链：前一个失败就换下一个。
 *
 * 关键决策：**不可重试错误不重试也不降级，直接上抛**（清单 598 行）。
 * 例如 TenantMissingError / GuardrailBlockedError 属于确定性拒绝，
 * 换模型再试一次没有任何意义，只会掩盖真实原因、放大延迟与成本。
 */
export class LlmFallbackChain implements Llm {
  readonly model: string;
  readonly tier: ModelTier;
  private readonly chain: Llm[];
  private readonly options: FallbackChainOptions;

  constructor(chain: Llm[], options: FallbackChainOptions = {}) {
    if (chain.length === 0) {
      throw new Error("LlmFallbackChain requires at least one Llm");
    }
    this.chain = chain;
    this.model = chain[0].model;
    this.tier = chain[0].tier;
    this.options = options;
  }

  /** 链式长度（测试断言用） */
  get length(): number {
    return this.chain.length;
  }

  async invoke(req: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;

    for (let i = 0; i < this.chain.length; i++) {
      const llm = this.chain[i];
      const retries = (this.options.maxRetries ?? 0) + 1;

      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const res = await llm.invoke(req);
          return i === 0
            ? res
            : { ...res, degraded: true, fallbackFrom: this.chain[0].model };
        } catch (err) {
          lastError = err;

          // 不可重试 → 立即上抛，既不重试也不降级
          if (err instanceof AgentError && !err.retryable) throw err;

          // 同模型还有重试机会
          if (attempt < retries - 1) continue;

          // 换下一个模型
          if (i < this.chain.length - 1) {
            this.options.onDegrade?.({
              from: llm.model,
              to: this.chain[i + 1].model,
              reason: err instanceof Error ? err.message : String(err),
              retryable: true,
            });
          }
        }
      }
    }

    // 所有候选模型均不可用时仍返回固定话术，保证 T6.1「任何单点故障下仍有响应」。
    // fallbackExhausted 由编排层识别并进入人工队列，不把固定话术伪装成模型答案。
    this.options.onDegrade?.({
      from: this.chain[this.chain.length - 1].model,
      to: null,
      reason: "all models unavailable",
      retryable: true,
    });
    return {
      text:
        this.options.fallbackText ??
        "当前智能客服暂时无法完成处理，我已为你转人工跟进，请稍候。",
      model: "fixed-fallback",
      tier: this.tier,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      degraded: true,
      fallbackFrom: this.chain[0].model,
      fallbackExhausted: true,
    };
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    // 流式降级：只在首个 chunk 产出前允许换模型，一旦开始吐字就不再切换，
    // 否则用户会看到两个模型的输出拼接。
    let started = false;
    for (let i = 0; i < this.chain.length; i++) {
      const llm = this.chain[i];
      if (!llm.stream) {
        const res = await llm.invoke(req);
        yield res.text;
        return;
      }
      try {
        for await (const chunk of llm.stream(req)) {
          started = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (started) throw err;
        if (err instanceof AgentError && !err.retryable) throw err;
        if (i < this.chain.length - 1) {
          this.options.onDegrade?.({
            from: llm.model,
            to: this.chain[i + 1].model,
            reason: err instanceof Error ? err.message : String(err),
            retryable: true,
          });
        }
      }
    }
    yield this.options.fallbackText ??
      "当前智能客服暂时无法完成处理，我已为你转人工跟进，请稍候。";
  }
}

/** 任务 → 档位的默认映射（T6.2）。可被 ModelRouter 配置覆盖 */
export const DEFAULT_TASK_TIER: Record<LlmTask, ModelTier> = {
  // 分派从主 Agent 解耦到专用轻量模型（Swiggy）
  triage: "simple",
  rewrite: "simple",
  // 专家处理具体类别，需要推理，但不总是需要旗舰
  specialist: "small",
  orchestrate: "small",
  generate: "large",
  review: "small",
};

export interface ModelRouterConfig {
  /** 任务 → 档位覆盖 */
  taskTier?: Partial<Record<LlmTask, ModelTier>>;
  /** 会话复杂度 → 档位提升规则 */
  escalateTierOn?: (ctx: { categories: string[]; urgency: string }) => ModelTier | null;
}

/**
 * 模型分级路由：按任务复杂度选档（T6.2）。
 *
 * 清单 614 行要求「模型选择结果可观测且可被评测集回放」——
 * 因此 resolve() 是纯函数：同样的 ctx 必然得到同样的档位，回放可复现。
 */
export class ModelRouter {
  private readonly taskTier: Record<LlmTask, ModelTier>;
  private readonly escalateTierOn: ModelRouterConfig["escalateTierOn"];
  private readonly tiers: Record<ModelTier, Llm[]>;

  constructor(tiers: Record<ModelTier, Llm[]>, config: ModelRouterConfig = {}) {
    this.tiers = tiers;
    this.taskTier = { ...DEFAULT_TASK_TIER, ...config.taskTier };
    this.escalateTierOn = config.escalateTierOn;
  }

  /** 解析某任务应使用的档位。纯函数，可回放 */
  resolveTier(
    task: LlmTask,
    ctx: { categories?: string[]; urgency?: string } = {},
  ): ModelTier {
    const base = this.taskTier[task];
    if (!this.escalateTierOn) return base;
    const forced = this.escalateTierOn({
      categories: ctx.categories ?? [],
      urgency: ctx.urgency ?? "normal",
    });
    return forced ?? base;
  }

  /** 取该任务的降级链（该档位 + 更高档位作为 fallback） */
  resolve(task: LlmTask, ctx: Parameters<ModelRouter["resolveTier"]>[1] = {}): Llm {
    const tier = this.resolveTier(task, ctx);
    const order: ModelTier[] = ["simple", "small", "large"];
    const start = order.indexOf(tier);
    const chain: Llm[] = [];
    for (let i = start; i < order.length; i++) {
      chain.push(...(this.tiers[order[i]] ?? []));
    }
    return new LlmFallbackChain(chain);
  }
}
