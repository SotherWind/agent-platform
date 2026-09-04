import { z } from "zod/v4";
import type { EvaluationReport } from "./types";

export const QualityGateConfigSchema = z.object({
  resolutionRateBaseline: z.number().min(0).max(1),
  satisfactionMinimum: z.number().min(1).max(5),
  securityTests: z.object({
    required: z.array(z.string()).min(1),
    blockOnFailure: z.literal(true),
  }),
});

export type QualityGateConfig = z.infer<typeof QualityGateConfigSchema>;

export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = QualityGateConfigSchema.parse({
  // 基线语义是「防退化的下限」而非质量目标：当前 fixture 集（12 条，含 5 条升级
  // 路径与 1 条二次来访）的真实 resolutionRate 是 0.5。目标值（如 0.75）应该通过
  // 扩评测集、提实现逐步逼近，而不是写进门禁让它永远红。
  resolutionRateBaseline: 0.5,
  satisfactionMinimum: 4,
  securityTests: {
    required: ["tenant-isolation", "action-confirmation", "guardrails"],
    blockOnFailure: true,
  },
});

export interface QualityGateInput {
  report: EvaluationReport;
  securityTestsPassed: boolean;
  config?: QualityGateConfig;
}

export interface QualityGateResult {
  passed: boolean;
  checks: {
    resolutionBaseline: { passed: boolean; actual: number; minimum: number };
    securityTests: { passed: boolean; blockOnFailure: true };
    satisfactionMinimum: {
      passed: boolean;
      actual: number | null;
      minimum: number;
      /** true 表示本次评测没有任何评分数据（单轮回放拿不到满意度），不阻断但显式回显 */
      noData: boolean;
    };
  };
}

export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const config = QualityGateConfigSchema.parse(input.config ?? DEFAULT_QUALITY_GATE_CONFIG);
  const resolutionBaseline = {
    passed: input.report.metrics.resolutionRate >= config.resolutionRateBaseline,
    actual: input.report.metrics.resolutionRate,
    minimum: config.resolutionRateBaseline,
  };
  const securityTests = {
    passed: input.securityTestsPassed,
    blockOnFailure: config.securityTests.blockOnFailure,
  } as const;
  // 满意度来自真实工单评价回流（T5.4）。单轮回放没有评价数据（ratedCaseCount=0），
  // 此时 null 是「没有数据」而不是「不达标」——不阻断，但显式回显 noData。
  // 一旦有数据，低于下限必须阻断。
  const noSatisfactionData = input.report.metrics.ratedCaseCount === 0;
  const satisfactionMinimum = {
    passed:
      noSatisfactionData ||
      (input.report.metrics.satisfactionAverage !== null &&
        input.report.metrics.satisfactionAverage >= config.satisfactionMinimum),
    actual: input.report.metrics.satisfactionAverage,
    minimum: config.satisfactionMinimum,
    noData: noSatisfactionData,
  };

  return {
    passed: resolutionBaseline.passed && securityTests.passed && satisfactionMinimum.passed,
    checks: { resolutionBaseline, securityTests, satisfactionMinimum },
  };
}

export function assertQualityGate(input: QualityGateInput): QualityGateResult {
  const result = evaluateQualityGate(input);
  if (!result.passed) {
    throw new Error(`质量门禁失败: ${JSON.stringify(result.checks)}`);
  }
  return result;
}
