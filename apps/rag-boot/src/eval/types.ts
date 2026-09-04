import { z } from "zod/v4";

export const SPECIALIST_CATEGORIES = [
  "billing",
  "integration",
  "account",
  "technical",
  "order",
  "general",
] as const;

export const SpecialistCategorySchema = z.enum(SPECIALIST_CATEGORIES);
export type SpecialistCategory = z.infer<typeof SpecialistCategorySchema>;

/**
 * fake LLM 剧本：回放时真跑图，各 stage 的响应由它决定。
 * 这是 P7「回放使用固定 seed 与 fake 外部服务」的落地形态——
 * 外部服务（LLM / 向量库）是 fake 的，但**图是真的**（buildGraph）。
 */
export const FixtureScriptSchema = z.object({
  /** 检索库按此回包（fake 向量库）；空数组模拟知识库未命中 */
  retrievedChunks: z.array(z.string()).default([]),
  triage: z
    .object({
      categories: z.array(z.string()).default(["general"]),
      urgency: z.enum(["low", "normal", "high"]).default("normal"),
      likelyNeedsHuman: z.boolean().default(false),
      needsRealtimeData: z.boolean().default(false),
    })
    .default({
      categories: ["general"],
      urgency: "normal",
      likelyNeedsHuman: false,
      needsRealtimeData: false,
    }),
  /** rewrite 阶段输出；缺省回退为用户 query */
  rewrite: z.string().optional(),
  /** 专家阶段输出（JSON 序列化前的对象）；缺省表示图不经专家节点 */
  specialist: z
    .object({
      status: z.string().default("resolved"),
      answer: z.string(),
      citations: z.array(z.string()).default([]),
    })
    .optional(),
  /** 生成阶段输出（最终答案正文） */
  generate: z.string(),
  review: z.object({
    passed: z.boolean(),
    violations: z
      .array(z.object({ code: z.string(), detail: z.string() }))
      .default([]),
  }),
});

export type FixtureScript = z.infer<typeof FixtureScriptSchema>;

export const EvaluationFixtureSchema = z.object({
  id: z.string().min(1),
  category: SpecialistCategorySchema,
  query: z.string().min(1),
  script: FixtureScriptSchema,
  /** 生成答案必须包含的片段——factuallyCorrect 的可复现判定依据（全中才算对） */
  expectContains: z.array(z.string()).default([]),
  /** 期望本轮调用的工具名清单——toolCallCorrect 的判定依据（集合相等才算对） */
  expectedTools: z.array(z.string()).default([]),
  /** 场景属性：该案例模拟的会话上下文。单轮回放无法自证二次来访，由标注给出 */
  context: z
    .object({ secondVisit: z.boolean().default(false) })
    .default({ secondVisit: false }),
  /** 人工标注的「这条该是什么样」。回放用它与图的真实行为比对 */
  expected: z.object({
    knowledgeHit: z.boolean(),
    factuallyCorrect: z.boolean(),
    toolCallCorrect: z.boolean(),
  }),
});

export type EvaluationFixture = z.infer<typeof EvaluationFixtureSchema>;

/**
 * 一次回放的观测值：全部字段从图的真实输出计算（不再是 fixture 里手写的数字）。
 * - knowledgeHit：citations 非空
 * - factuallyCorrect：finalAnswer 含全部 expectContains
 * - toolCallCorrect：本轮 toolCalls 与 expectedTools 集合相等
 * - humanInvolved：escalation.required
 * - deflected：未升级且非空检索兜底
 * - latencyMs / costUsd：实测延迟与按 token 估算的成本
 * - secondVisit：场景标注（单轮回放无法自证）；satisfaction：真实生产由工单评价回流
 */
export interface ReplayObservation {
  knowledgeHit: boolean;
  factuallyCorrect: boolean;
  toolCallCorrect: boolean;
  humanInvolved: boolean;
  secondVisit: boolean;
  deflected: boolean;
  latencyMs: number;
  costUsd: number;
  satisfaction: number | null;
  seed: number;
  replayToken: string;
}

export interface ReplayCall {
  caseId: string;
  category: SpecialistCategory;
  seed: number;
  replayToken: string;
}

export interface EvaluationResult {
  caseId: string;
  category: SpecialistCategory;
  query: string;
  passed: boolean;
  expected: EvaluationFixture["expected"];
  observed: ReplayObservation;
  knowledgeHit: boolean;
  factuallyCorrect: boolean;
  toolCallCorrect: boolean;
  humanInvolved: boolean;
  secondVisit: boolean;
  deflected: boolean;
  resolved: boolean;
  latencyMs: number;
  costUsd: number;
  satisfaction: number | null;
}

export interface HumanBaseline {
  resolutionRate: number;
  label?: string;
}

export interface EvaluationMetrics {
  totalCases: number;
  passedCases: number;
  passRate: number;
  knowledgeHitRate: number;
  factualAccuracyRate: number;
  toolCallAccuracyRate: number;
  resolutionRate: number;
  deflectionRate: number;
  escalationRate: number;
  p95LatencyMs: number;
  averageCostPerSessionUsd: number;
  satisfactionAverage: number | null;
  ratedCaseCount: number;
  metricNotes: {
    resolutionRate: string;
    deflectionRate: string;
  };
}

export interface SavingsConclusion {
  label: string;
  resolutionRate: number;
  humanBaselineResolutionRate: number;
  delta: number;
}

export interface EvaluationReport {
  seed: number;
  results: EvaluationResult[];
  metrics: EvaluationMetrics;
  savingsConclusion?: SavingsConclusion;
}

export interface EvaluationOptions {
  seed?: number;
  humanBaseline?: HumanBaseline;
  fixtureDir?: string;
}
