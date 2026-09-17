/**
 * T7.1 回放：真跑图。
 *
 * 此前实现是 `return { ...fixture.replay, seed, replayToken }`——期望值和观测值
 * 都是 JSONL 里手写的，评测闭环与 Agent 真实行为完全无关（Klarna 教训章节的
 * 质量门禁实际上在空转）。
 *
 * 现在的做法：fixture.script 决定 fake LLM 各 stage 的响应与 fake 向量库的回包，
 * 然后用 buildGraph 真跑一遍图，observed 全部从图输出计算。这样当实现退化
 * （比如检索断了 → knowledgeHit 变 false），回放会真实地变红。
 */
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import { EMPTY_RETRIEVAL_FALLBACK } from "../nodes/generate";
import type { RetrievedChunk } from "../schema";
import type { EvaluationFixture, ReplayObservation } from "./types";

/** 估算成本单价（USD / token）：fake LLM 的 token 计数是真实的，单价是约定常数 */
export const USD_PER_TOKEN = 0.000_002;

export function hashSeed(seed: number, value: string): number {
  let hash = seed | 0;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function replayTokenFor(seed: number, fixtureId: string): string {
  return `${seed.toString(16)}-${hashSeed(seed, fixtureId).toString(16)}`;
}

export interface GraphReplayResult {
  observation: ReplayObservation;
  finalAnswer: string;
  toolCalls: string[];
}

export async function runFixtureThroughGraph(
  fixture: EvaluationFixture,
  options: { seed: number },
): Promise<GraphReplayResult> {
  const { seed } = options;
  const script = fixture.script;

  const retrievedChunks: RetrievedChunk[] = script.retrievedChunks.map((content, i) => ({
    id: `c${i + 1}`,
    documentId: `doc-c${i + 1}`,
    tenantId: "tenant-eval",
    content,
    // fixture 未指定分数时退化为 0.9（保持既有 fixture 行为不变）；
    // 指定了就用指定的——这样群像式幻觉这类分布才能进评测。
    score: script.chunkScores?.[i] ?? 0.9,
    metadata: {},
  }));

  const byStage: Record<string, string> = {
    triage: JSON.stringify(script.triage),
    rewrite: script.rewrite ?? fixture.query,
    generate: script.generate,
    review: JSON.stringify(script.review),
  };
  if (script.specialist) byStage.specialist = JSON.stringify(script.specialist);

  const model = createFakeLlm({ byStage });
  const graph = await buildGraph({
    vectorStore: {
      search: async () => retrievedChunks,
      addDocuments: async () => 0,
      ingestFile: async () => 0,
      deleteByDocumentId: async () => {},
    },
    reranker: null,
    llms: { simple: model, small: model, large: model },
  });

  const threadId = `eval-${fixture.id}`;
  const startedAt = Date.now();
  const result = await graph.invoke(
    { query: fixture.query, tenantId: "tenant-eval", threadId, messages: [] },
    { configurable: { thread_id: threadId } },
  );
  const latencyMs = Date.now() - startedAt;

  const finalAnswer = result.finalAnswer ?? "";
  const humanInvolved = result.escalation?.required === true;
  const toolCalls = (result.toolCalls ?? []).map((t) => t.name);
  const expectedTools = [...fixture.expectedTools].sort();
  const actualTools = [...toolCalls].sort();

  const observation: ReplayObservation = {
    knowledgeHit: (result.citations ?? []).length > 0,
    factuallyCorrect: fixture.expectContains.every((s) => finalAnswer.includes(s)),
    toolCallCorrect:
      expectedTools.length === actualTools.length &&
      expectedTools.every((t, i) => t === actualTools[i]),
    humanInvolved,
    secondVisit: fixture.context.secondVisit,
    deflected:
      !humanInvolved && finalAnswer !== "" && finalAnswer !== EMPTY_RETRIEVAL_FALLBACK,
    // 闸门行为取自图的真实输出（不是 fixture 手写），因此可以被端到端断言
    lowConfidence: result.lowConfidence === true,
    flockHallucination: result.confidenceDiagnostics?.flockHallucination === true,
    supportCount: result.confidenceDiagnostics?.supportCount ?? 0,
    latencyMs,
    costUsd: Number(((result.budget?.totalTokens ?? 0) * USD_PER_TOKEN).toFixed(6)),
    // 满意度来自真实用户的工单评价（T5.4 回流），单轮回放拿不到 → null 而不是编一个数
    satisfaction: null,
    seed,
    replayToken: replayTokenFor(seed, fixture.id),
  };

  return { observation, finalAnswer, toolCalls };
}
