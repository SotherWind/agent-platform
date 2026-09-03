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
  resolutionRateBaseline: 0.8,
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
    satisfactionMinimum: { passed: boolean; actual: number | null; minimum: number };
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
  const satisfactionMinimum = {
    passed:
      input.report.metrics.satisfactionAverage !== null &&
      input.report.metrics.satisfactionAverage >= config.satisfactionMinimum,
    actual: input.report.metrics.satisfactionAverage,
    minimum: config.satisfactionMinimum,
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
