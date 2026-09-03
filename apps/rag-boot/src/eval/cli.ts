import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { calculateSavingsConclusion } from "./metrics";
import { runEvaluation } from "./runner";
import { assertQualityGate, QualityGateConfigSchema } from "./quality-gate";

const seed = Number(process.env.EVAL_SEED ?? "20260903");
const baselineText = process.env.HUMAN_BASELINE_RESOLUTION_RATE;
const humanBaseline = baselineText === undefined ? undefined : { resolutionRate: Number(baselineText) };
const report = await runEvaluation({ seed, humanBaseline });

if (process.argv.includes("--gate")) {
  const configText = await readFile(fileURLToPath(new URL("./quality-gate.config.json", import.meta.url)), "utf8");
  const config = QualityGateConfigSchema.parse(JSON.parse(configText));
  assertQualityGate({
    report,
    config,
    securityTestsPassed: process.env.SECURITY_TESTS_PASSED === "true",
  });
}

if (process.argv.includes("--savings")) {
  if (!humanBaseline) throw new Error("拒绝输出 savings 结论：请提供 HUMAN_BASELINE_RESOLUTION_RATE");
  report.savingsConclusion = calculateSavingsConclusion(report.metrics, humanBaseline);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
