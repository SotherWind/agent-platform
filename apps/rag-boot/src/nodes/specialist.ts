/**
 * T1.3 专家节点
 *
 * 一个节点内顺序跑多个被标记的类别（Diffco 是并行，但并行需要引入额外调度，
 * 且清单末段建议「先用单专家跑通」）。并行执行的**无状态串扰**保证在这里靠
 * 「每个专家只读 state、只写自己的输出对象」实现——输出是独立的结构化对象，
 * 专家之间没有共享可变状态，也没有自然语言对话。
 */
import { SpecialistOutputSchema, type SpecialistOutput, type RerankedChunk } from "../schema";
import { getSpecialistPrompt } from "../prompts/specialists";
import { enforceToolBoundary, getSpecialist } from "./specialists";
import { parseJsonLoose } from "../guardrails/output";
import type { Llm, LlmResponse } from "../llm/types";

export interface SpecialistNodeInput {
  categories: string[];
  query: string;
  sanitizedQuery: string;
  contextChunks: RerankedChunk[];
  /** 已完成的工具结果（来自前几轮循环） */
  toolResults: Array<{ name: string; ok: boolean; summary: string }>;
  /** 本轮是否已经调用过工具：避免重复请求同一个工具造成死循环 */
  calledToolNames: string[];
  lowConfidence: boolean;
}

export interface SpecialistNodeOptions {
  llm?: Llm;
  onUsage?: (response: LlmResponse) => void;
}

const CONTEXT_BLOCK = (chunks: RerankedChunk[]): string =>
  chunks.length > 0
    ? chunks
        .map((c, i) => `[${i + 1}] (chunkId=${c.id}, score=${c.rerankScore?.toFixed(3)}) ${c.content}`)
        .join("\n\n")
    : "（无可用上下文）";

/**
 * 单专家执行。
 * 对外暴露是为了 T1.3 的「多个专家并行执行，互不共享可变状态」可单测。
 */
export async function runSpecialist(
  category: string,
  input: SpecialistNodeInput,
  options: SpecialistNodeOptions = {},
): Promise<SpecialistOutput> {
  const def = getSpecialist(category);

  // 无模型：退化为「按上下文直接给结论」的保守路径，返回 needsOrchestrator，
  // 让编排器来决定怎么拼。没有模型时不伪造 resolved。
  if (!options.llm) {
    return SpecialistOutputSchema.parse({
      category,
      status: input.contextChunks.length > 0 ? "needsOrchestrator" : "escalate",
      partialAnswer: "",
      gap: input.contextChunks.length > 0 ? "no model available" : "no context and no model",
      reason: input.contextChunks.length > 0 ? "" : "no context available",
      toolRequests: [],
      rejectedToolRequests: [],
      citations: [],
      promptVersion: getSpecialistPrompt(category).version,
    });
  }

  // 每专家独立提示词（独立版本轨，T1.3）：不再是同一模板 + {{category}} 占位
  const system = getSpecialistPrompt(category).system;

  const prompt = [
    `【用户问题】${input.sanitizedQuery || input.query}`,
    `【可用工具】${def.toolNames.join(", ") || "（无）"}`,
    `【已完成的工具调用】`,
    input.toolResults.length > 0
      ? input.toolResults.map((t) => `- ${t.name}: ${t.ok ? "成功" : "失败"} - ${t.summary}`).join("\n")
      : "（无）",
    input.calledToolNames.length > 0
      ? `【本轮已调用过的工具】${input.calledToolNames.join(", ")}（不要再重复请求）`
      : "",
    input.lowConfidence ? "【提示】当前检索置信度偏低，不确定时请返回 needsOrchestrator，不要硬答。" : "",
    `【知识上下文】`,
    CONTEXT_BLOCK(input.contextChunks),
  ]
    .filter(Boolean)
    .join("\n\n");

  let parsed: Record<string, unknown> | null = null;
  try {
    const res = await options.llm.invoke({
      system,
      prompt,
      json: true,
      stage: "specialist",
    });
    options.onUsage?.(res);
    parsed = parseJsonLoose(res.text) as Record<string, unknown> | null;
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    // 非法输出：保守走 escalate，绝不猜一个结论继续
    return SpecialistOutputSchema.parse({
      category,
      status: "escalate",
      reason: "specialist returned invalid JSON",
      toolRequests: [],
      rejectedToolRequests: [],
      citations: [],
      promptVersion: getSpecialistPrompt(category).version,
    });
  }

  const rawRequests = Array.isArray(parsed.toolRequests)
    ? (parsed.toolRequests as Array<{ name?: string; args?: Record<string, unknown> }>)
        .filter((r) => typeof r?.name === "string")
        .map((r) => ({ name: r.name as string, args: r.args ?? {} }))
    : [];

  // 工具边界：代码校验，不靠模型自觉
  const { allowed, rejected } = enforceToolBoundary(rawRequests, category);

  const statusRaw = String(parsed.status ?? "resolved");
  const status: SpecialistOutput["status"] =
    statusRaw === "escalate"
      ? "escalate"
      : statusRaw === "needsOrchestrator"
        ? "needsOrchestrator"
        : "resolved";

  return SpecialistOutputSchema.parse({
    category,
    status,
    answer: typeof parsed.answer === "string" ? parsed.answer : "",
    partialAnswer: typeof parsed.partialAnswer === "string" ? parsed.partialAnswer : "",
    gap: typeof parsed.gap === "string" ? parsed.gap : "",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    toolRequests: allowed,
    rejectedToolRequests: rejected,
    citations: Array.isArray(parsed.citations)
      ? parsed.citations.filter((c): c is string => typeof c === "string")
      : [],
    promptVersion: getSpecialistPrompt(category).version,
  });
}

/**
 * 跑全部被标记的类别。
 *
 * 无状态保证：每个专家的输入是从 state 派生的只读快照（toolResults / contextChunks 都
 * 是入参传入），输出写进各自的 SpecialistOutput 对象，专家之间不存在共享可变引用。
 */
export async function runSpecialists(
  input: SpecialistNodeInput,
  options: SpecialistNodeOptions = {},
): Promise<SpecialistOutput[]> {
  const categories = input.categories.length > 0 ? input.categories : ["general"];
  // 每个专家只读共享快照、返回独立结构化对象；Promise.all 避免一个专家等待另一个专家，
  // 并保证没有通过可变 state 在专家之间串数据的路径。
  return Promise.all(categories.map((category) => runSpecialist(category, input, options)));
}
