/**
 * T1.4 编排器（Orchestrator）
 *
 * 依据 Diffco 阶段 4：只做拼接与冲突消解，**不重做工作**，且**编排器没有任何工具**。
 *
 * 两条硬规则：
 * 1. 编排器工具清单为空（清单 277 行 `expect(orchestrator.tools).toHaveLength(0)`）。
 *    这不是形式主义：给编排器工具，等于把「能在多个专家结论之上再动手」的能力
 *    集中到一个没有领域边界约束的节点上，爆炸半径反而比专家更大。
 * 2. 专家间通信载体是**结构化对象**，不是自然语言段落
 *    （Diffco 明确拒绝「Agent 用自然语言互相辩论」：演示里好玩，生产中不稳定）。
 */
import type { SpecialistOutput } from "../schema";
import { ORCHESTRATOR_PROMPT } from "../prompts";
import { parseJsonLoose } from "../guardrails/output";
import { priorityOf } from "./specialists";
import type { Llm, LlmResponse } from "../llm/types";

/** 编排器的工具清单：恒为空。这是设计约束，不是配置 */
export const ORCHESTRATOR_TOOLS: readonly string[] = Object.freeze([]);

export interface OrchestrateResult {
  answer: string;
  conflictResolved: string[];
  /** 是否走了模型编排（false = 纯规则拼接或单专家直通） */
  usedModel: boolean;
}

/**
 * 只有多专家输出时才介入，单专家直通（清单 276 行）。
 *
 * 直通很重要：单专家场景过一遍编排器，等于多花一次调用去「拼接」一份本来就完整的
 * 答案，还引入了一次被改坏的机会。
 */
export async function orchestrate(
  outputs: SpecialistOutput[],
  options: { llm?: Llm; onUsage?: (response: LlmResponse) => void } = {},
): Promise<OrchestrateResult> {
  const usable = outputs.filter(
    (o) => o.status === "resolved" || o.status === "needsOrchestrator",
  );

  if (usable.length === 0) {
    return { answer: "", conflictResolved: [], usedModel: false };
  }

  // 单专家直通
  if (usable.length === 1) {
    const only = usable[0];
    return {
      answer: only.status === "resolved" ? only.answer : only.partialAnswer,
      conflictResolved: [],
      usedModel: false,
    };
  }

  // 多专家：先做确定性冲突消解，再决定要不要请模型
  const conflictResolved = resolveConflicts(usable);

  // 都完整 → 直接按优先级拼接，不必再花一次模型调用
  if (usable.every((o) => o.status === "resolved")) {
    return {
      answer: joinAnswers(usable),
      conflictResolved,
      usedModel: false,
    };
  }

  if (!options.llm) {
    // 无模型：拼接已有内容，缺失的部分如实说明
    return {
      answer: joinAnswers(usable),
      conflictResolved: [
        ...conflictResolved,
        "终审编排模型不可用，已按确定性规则拼接（降级标记）",
      ],
      usedModel: false,
    };
  }

  // 有模型：把结构化输出交给模型拼接。传的是 JSON，不是自然语言段落。
  const prompt = [
    `【用户问题相关上下文】`,
    JSON.stringify(
      usable.map((o) => ({
        category: o.category,
        status: o.status,
        answer: o.answer,
        partialAnswer: o.partialAnswer,
        gap: o.gap,
        citations: o.citations,
      })),
      null,
      2,
    ),
    `【冲突消解规则】${conflictResolved.join("；") || "（无冲突）"}`,
  ].join("\n\n");

  try {
    const res = await options.llm.invoke({
      system: ORCHESTRATOR_PROMPT.system,
      prompt,
      json: true,
      stage: "orchestrate",
    });
    options.onUsage?.(res);
    const parsed = parseJsonLoose(res.text) as
      | { answer?: string; conflictResolved?: string[] }
      | null;

    if (parsed && typeof parsed.answer === "string" && parsed.answer.trim()) {
      return {
        answer: parsed.answer,
        conflictResolved: [
          ...conflictResolved,
          ...(Array.isArray(parsed.conflictResolved) ? parsed.conflictResolved : []),
        ],
        usedModel: true,
      };
    }
  } catch {
    // 编排模型失败：回落到确定性拼接，绝不阻断回复
  }

  return {
    answer: joinAnswers(usable),
    conflictResolved: [...conflictResolved, "编排模型未产出可用结果，已回落到确定性拼接"],
    usedModel: false,
  };
}

/**
 * 确定性冲突消解：按专家优先级排序，标注被压制的类别。
 * 优先级来自专家注册表（technical 最高，因为服务不可用通常压过账单问题）。
 */
export function resolveConflicts(outputs: SpecialistOutput[]): string[] {
  if (outputs.length <= 1) return [];

  const ranked = [...outputs].sort((a, b) => priorityOf(b.category) - priorityOf(a.category));
  const notes: string[] = [];

  for (let i = 1; i < ranked.length; i++) {
    notes.push(
      `类别「${ranked[i].category}」的结论优先级低于「${ranked[0].category}」，冲突时以后者为准`,
    );
  }

  const gapped = ranked.filter((o) => o.gap);
  for (const o of gapped) {
    notes.push(`类别「${o.category}」信息缺失：${o.gap}`);
  }

  return notes;
}

/** 按优先级拼接答案 */
export function joinAnswers(outputs: SpecialistOutput[]): string {
  const ranked = [...outputs].sort((a, b) => priorityOf(b.category) - priorityOf(a.category));
  return ranked
    .map((o) => (o.status === "resolved" ? o.answer : o.partialAnswer))
    .filter((s) => s && s.trim())
    .join("\n\n")
    .trim();
}
