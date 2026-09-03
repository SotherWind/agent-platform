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

export const EvaluationFixtureSchema = z.object({
  id: z.string().min(1),
  category: SpecialistCategorySchema,
  query: z.string().min(1),
  expected: z.object({
    knowledgeHit: z.boolean(),
    factuallyCorrect: z.boolean(),
    toolCallCorrect: z.boolean(),
  }),
  replay: z.object({
    knowledgeHit: z.boolean(),
    factuallyCorrect: z.boolean(),
    toolCallCorrect: z.boolean(),
    humanInvolved: z.boolean(),
    secondVisit: z.boolean(),
    deflected: z.boolean(),
    latencyMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    satisfaction: z.number().min(1).max(5).nullable().default(null),
  }),
});

export type EvaluationFixture = z.infer<typeof EvaluationFixtureSchema>;
export type ReplayData = EvaluationFixture["replay"];

export type ReplayObservation = ReplayData & {
  seed: number;
  replayToken: string;
};

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
