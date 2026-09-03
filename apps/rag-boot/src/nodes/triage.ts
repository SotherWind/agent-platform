/**
 * T1.1 分诊节点（Triage）
 *
 * 依据 Diffco 阶段 2：小模型一次调用，多标签分类 + 紧急度 + 是否需人工，
 * 严格 JSON schema，**门控下游全部流程**。
 *
 * 两条硬规则：
 * 1. **规则前置**：命中「转人工」「投诉」「人工客服」等关键词直接置 likelyNeedsHuman，
 *    不经模型。对应 Swiggy「规则路由 + 轻量模型」——纯 LLM 分派实测仅 90% 准确率，
 *    而这类明确指令用规则是 100% 且不花钱（清单 215 行要求规则路径不消耗 token）。
 * 2. **非法输出降级为转人工**：模型返回非法 JSON 时按保守策略处理，
 *    绝不崩溃，也绝不「猜一个分类继续走」——猜错类别会把工单派到错误的专家，
 *    比直接转人工代价更高。
 */
import { TriageResultSchema, type TriageResult } from "../schema";
import { TRIAGE_PROMPT } from "../prompts";
import { parseJsonLoose } from "../guardrails/output";
import type { Llm, LlmResponse } from "../llm/types";

export interface TriageNodeOptions {
  llm?: Llm;
  onUsage?: (response: LlmResponse) => void;
  /** 紧急度关键词 */
  highUrgencyPatterns?: RegExp[];
  /** 需要实时数据的关键词 */
  realtimePatterns?: RegExp[];
}

export const DEFAULT_HIGH_URGENCY_PATTERNS: RegExp[] = [
  /无法登录|登不进去|账号被锁/gi,
  /服务(挂了|不可用|宕机)/gi,
  /生产环境/gi,
  /数据丢失|误删/gi,
  /重复扣款|扣了两次/gi,
  /紧急|急!/gi,
];

export const DEFAULT_REALTIME_PATTERNS: RegExp[] = [
  /订单(状态|到哪|在哪|进度)/gi,
  /物流|快递|发货/gi,
  /(我的)?账单(金额|多少|多少钱)/gi,
  /余额|剩余(额度|次数)/gi,
  /库存/gi,
  /当前(套餐|订阅)/gi,
];

/** 保守降级：模型不可用时按「需要人工」处理，不放行到下游 */
export function conservativeTriage(): TriageResult {
  return TriageResultSchema.parse({
    categories: ["general"],
    urgency: "normal",
    likelyNeedsHuman: true,
    needsRealtimeData: false,
    source: "fallback",
  });
}

export interface TriageInput {
  query: string;
  history: Array<{ role: string; content: string }>;
  /** 用户是否明确要求人工（由 T5.1 的 isHumanRequest 判定） */
  humanRequested?: boolean;
}

/**
 * 分诊。返回 TriageResult，source 字段标明判定来源，便于评测时分别统计
 * 规则命中率与模型准确率（T7.2）。
 */
export async function triage(
  input: TriageInput,
  options: TriageNodeOptions = {},
): Promise<TriageResult> {
  const highUrgency = options.highUrgencyPatterns ?? DEFAULT_HIGH_URGENCY_PATTERNS;
  const realtime = options.realtimePatterns ?? DEFAULT_REALTIME_PATTERNS;

  // 规则前置：明确要求人工 → 直接置位，不消耗 token
  if (input.humanRequested) {
    return TriageResultSchema.parse({
      categories: ["general"],
      urgency: "high",
      likelyNeedsHuman: true,
      needsRealtimeData: false,
      source: "rule",
    });
  }

  const isHighUrgency = highUrgency.some((r) => r.test(input.query));
  const needsRealtime = realtime.some((r) => r.test(input.query));

  let modelResult: Partial<TriageResult> = {};

  if (options.llm) {
    const recentHistory = input.history.slice(-6);
    const prompt = [
      recentHistory.length > 0
        ? `【历史对话】\n${recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")}`
        : "",
      `【当前问题】\n${input.query}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const res = await options.llm.invoke({
        system: TRIAGE_PROMPT.system,
        prompt,
        json: true,
        temperature: 0,
        stage: "triage",
      });
      options.onUsage?.(res);
      const parsed = parseJsonLoose(res.text);
      if (parsed && typeof parsed === "object") {
        modelResult = parsed as Partial<TriageResult>;
      } else {
        // 非法 JSON：保守降级（不抛错，但标记需要人工）
        return conservativeTriage();
      }
    } catch {
      // 模型不可用：同样保守降级——降级链已在上层处理，这里不再重试
      return conservativeTriage();
    }
  } else if (!options.llm && !isHighUrgency && !needsRealtime) {
    // 既没有模型也没有规则命中：保守降级
    return conservativeTriage();
  }

  // 模型结果与规则结果合并：规则优先（规则是硬约束，模型是建议）
  return TriageResultSchema.parse({
    categories:
      Array.isArray(modelResult.categories) && modelResult.categories.length > 0
        ? modelResult.categories
        : ["general"],
    urgency: isHighUrgency ? "high" : (modelResult.urgency ?? "normal"),
    likelyNeedsHuman: isHighUrgency || Boolean(modelResult.likelyNeedsHuman),
    needsRealtimeData: needsRealtime || Boolean(modelResult.needsRealtimeData),
    source: "model",
  });
}
