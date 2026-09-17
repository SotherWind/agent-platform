/**
 * 阈值标定 CLI：从历史人工接管的 case 出闸门参数，产出可入库的 profile JSON。
 *
 * 用法：
 *   pnpm calibrate --input data/handoff-2026Q1.jsonl --out config/confidence
 *   pnpm calibrate --input data/handoff.jsonl --out config/confidence --target-recall 0.95 --max-fpr 0.2
 *   pnpm calibrate --input data/handoff.jsonl --out config/confidence --baseline data/handoff-2025Q4.jsonl
 *
 * 输入 JSONL 每行一条（字段说明与采集方式见 docs/confidence-calibration.md）：
 *   { "id": "...", "chunkScores": [0.36, 0.34, 0.33, 0.33, 0.32], "shouldEscalate": true,
 *     "rerankerModel": "Qwen3-Reranker-8B", "kbVersion": "kb-2026-03", "domain": "商品咨询" }
 *
 * `chunkScores` 是**硬前提**而不是可选优化：`floor` / `solid` 都作用在 rerank 原始分数
 * 尺度上，闸门判决还依赖 top / min / 过线条数。只落一个合成分数是标不出来的，
 * schema 会直接拒绝——宁可让人补数据，也不要产出一个尺度错位的阈值。
 * 落盘请直接用 `buildCalibrationRecord()`，它保证 score 与 chunkScores 出自同一 policy。
 *
 * 本文件只做参数解析、读写文件、打印。标定逻辑在 `src/confidence/calibration-runner.ts`，
 * 那是被单测覆盖的纯函数——标定错了线上是静默变差，不能靠肉眼验收。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OperatingPointMode } from "../src/confidence/calibration";
import {
  calibrateGroup,
  groupByKey,
  groupKeyOf,
  parseJsonl,
  profileFileName,
  type CalibrateOptions,
  type CalibrateGroupResult,
  type CalibrationRecord,
} from "../src/confidence/calibration-runner";

export interface CliOptions {
  input: string;
  out: string;
  baseline?: string;
  mode: OperatingPointMode;
  targetRecall: number;
  minPrecision: number;
  maxFpr: number;
  floorTolerance: number;
  floorMinSupport: number;
  solidTolerance: number;
  solidMinSupport: number;
  refinePasses: number;
  validationShare: number;
  gridResolution: number;
  sensitivity: boolean;
  minSample: number;
  minPositives: number;
  minNegatives: number;
  force: boolean;
}

const USAGE =
  "用法: calibrate --input <labeled.jsonl> --out <profile-dir> [--baseline <prev.jsonl>]\n" +
  "      [--mode recall_floor|youden|precision_floor] [--target-recall 0.9] [--max-fpr 0.3]\n" +
  "      [--floor-tolerance 0.05] [--floor-min-support 20]\n" +
  "      [--solid-tolerance 0.05] [--solid-min-support 20] [--refine-passes 2]\n" +
  "      [--validation-share 0.3] [--grid-resolution 6] [--no-sensitivity]\n" +
  "      [--min-precision 0.9] [--min-sample 200] [--force]";

export function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const input = get("--input");
  const out = get("--out");
  if (!input || !out) throw new Error(USAGE);
  const baseline = get("--baseline");
  return {
    input: resolve(input),
    out: resolve(out),
    baseline: baseline ? resolve(baseline) : undefined,
    mode: (get("--mode") as OperatingPointMode) ?? "recall_floor",
    targetRecall: Number(get("--target-recall") ?? 0.9),
    minPrecision: Number(get("--min-precision") ?? 0.9),
    maxFpr: Number(get("--max-fpr") ?? 0.3),
    floorTolerance: Number(get("--floor-tolerance") ?? 0.05),
    floorMinSupport: Number(get("--floor-min-support") ?? 20),
    solidTolerance: Number(get("--solid-tolerance") ?? 0.05),
    solidMinSupport: Number(get("--solid-min-support") ?? 20),
    refinePasses: Number(get("--refine-passes") ?? 2),
    validationShare: Number(get("--validation-share") ?? 0.3),
    gridResolution: Number(get("--grid-resolution") ?? 6),
    sensitivity: !argv.includes("--no-sensitivity"),
    minSample: Number(get("--min-sample") ?? 200),
    minPositives: Number(get("--min-positives") ?? 50),
    minNegatives: Number(get("--min-negatives") ?? 50),
    force: argv.includes("--force"),
  };
}

export function toCalibrateOptions(options: CliOptions): CalibrateOptions {
  return {
    mode: options.mode,
    targetRecall: options.targetRecall,
    minPrecision: options.minPrecision,
    maxFpr: options.maxFpr,
    floorTolerance: options.floorTolerance,
    floorMinSupport: options.floorMinSupport,
    solidTolerance: options.solidTolerance,
    solidMinSupport: options.solidMinSupport,
    refinePasses: options.refinePasses,
    validationShare: options.validationShare,
    gridResolution: options.gridResolution,
    sensitivity: options.sensitivity,
    minSample: options.minSample,
    minPositives: options.minPositives,
    minNegatives: options.minNegatives,
    force: options.force,
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** PSI 判读：0.1 以下稳定，0.1~0.25 看一眼，0.25 以上不能沿用 */
function describePsi(psi: number): string {
  if (psi > 0.25) return "分布显著漂移，本次标定结果不可直接沿用";
  if (psi > 0.1) return "分布有漂移，建议人工复核";
  return "分布稳定";
}

function reportGroup(result: CalibrateGroupResult): void {
  const { key, profile, confusion } = result;
  if (result.skipped || !profile) {
    console.log(`⛔ ${key}`);
    for (const reason of result.skipReasons) console.log(`   - ${reason}`);
    for (const note of result.notes) console.log(`   ℹ️ ${note}`);
    console.log("");
    return;
  }

  console.log(`✅ ${key}`);
  console.log(
    `   floor=${profile.floor}  solid=${profile.solid}  ` +
      `minRange=${profile.minRange}  minSupportShare=${profile.minSupportShare}  ` +
      `flockDiscriminationMax=${profile.flockDiscriminationMax}  coverageWeight=${profile.coverageWeight}`,
  );
  if (confusion) {
    console.log(
      `   召回(tpr)=${pct(confusion.tpr)} [${pct(confusion.recallCi.low)}, ${pct(confusion.recallCi.high)}]  ` +
        `误伤(fpr)=${pct(confusion.fpr)} [${pct(confusion.falsePositiveCi.low)}, ${pct(confusion.falsePositiveCi.high)}]  ` +
        `精度=${pct(confusion.precision)}`,
    );
    console.log(
      `   样本 n=${confusion.sampleSize}（pos=${confusion.positives}, neg=${confusion.negatives}）  ` +
        `群像触发=${confusion.flockCount}`,
    );
  }
  console.log(
    `   AUC=${result.auc ?? "n/a（单类样本，无定义）"}  （对合成分数计算，衡量部署中的判决函数）`,
  );
  // 标定集成绩会被选择偏差抬高，留出集才是上线预期 —— 两个都要看
  if (result.validation) {
    console.log(
      `   留出集（无偏参照）：n=${result.validation.sampleSize}  ` +
        `召回=${pct(result.validation.tpr)}  误伤=${pct(result.validation.fpr)}  精度=${pct(result.validation.precision)}`,
    );
  }
  if (result.generalization) {
    console.log(
      `   泛化差距：召回 ${(result.generalization.tprGap * 100).toFixed(1)}pp / ` +
        `误伤 ${(result.generalization.fprGap * 100).toFixed(1)}pp  ` +
        (result.generalization.overfitSuspect ? "⚠️ 判为过拟合嫌疑" : "在噪声范围内"),
    );
  } else {
    console.log(`   泛化差距：无法测量（留出集过小）——上面的成绩只反映标定集`);
  }
  if (result.psi !== null) console.log(`   PSI=${result.psi} ← ${describePsi(result.psi)}`);
  console.log(`   topScore 分布：median=${result.distribution?.median} p95=${result.distribution?.p95}`);
  if (result.refine) console.log(`   坐标下降评估次数=${result.refine.evaluations}`);
  for (const note of result.notes) console.log(`   ℹ️ ${note}`);
  if (result.sensitivitySummary) {
    console.log("   敏感性（该选择落在平台期还是刀尖上）：");
    for (const entry of result.sensitivitySummary) {
      console.log(
        `     ${entry.knob}: ${entry.feasibleAlternatives}/${entry.alternatives} 个其他候选值同样可行 — ${entry.verdict}`,
      );
    }
  }
  if (result.gridRationale) {
    console.log("   候选网格来源：");
    for (const [knob, why] of Object.entries(result.gridRationale)) {
      console.log(`     ${knob}: ${why}`);
    }
  }
  if (result.scalarBaseline) {
    console.log(
      `   对照口径（若链路只输出一个标量分数）：阈值=${result.scalarBaseline.threshold.toFixed(4)}，` +
        `召回=${pct(result.scalarBaseline.tpr)}，误伤=${pct(result.scalarBaseline.fpr)}` +
        (result.scalarBaseline.metTarget ? "" : "  ⚠️ 未达约束"),
    );
  }
  for (const reason of result.skipReasons) console.log(`   ⚠️ ${reason}`);
  console.log("");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const records = parseJsonl(await readFile(options.input, "utf-8"), options.input);
  const baselineRecords = options.baseline
    ? parseJsonl(await readFile(options.baseline, "utf-8"), options.baseline)
    : undefined;

  console.log(`📄 标定数据：${options.input}（${records.length} 条，均带 chunkScores）`);
  console.log(
    `🎯 业务约束：召回 ≥ ${pct(options.targetRecall)}，误伤 ≤ ${pct(options.maxFpr)}` +
      `（坐标下降按这两个约束判可行；${options.mode} 只用于对照口径）`,
  );
  console.log("");

  await mkdir(options.out, { recursive: true });

  const baselineByKey = new Map<string, CalibrationRecord[]>();
  for (const record of baselineRecords ?? []) {
    const key = groupKeyOf(record);
    const bucket = baselineByKey.get(key);
    if (bucket) bucket.push(record);
    else baselineByKey.set(key, [record]);
  }

  const calibrateOptions = toCalibrateOptions(options);
  const results: CalibrateGroupResult[] = [];
  for (const [key, group] of groupByKey(records)) {
    const result = calibrateGroup(key, group, calibrateOptions, baselineByKey.get(key));
    results.push(result);
    reportGroup(result);

    if (result.skipped || !result.profile) continue;
    const target = join(options.out, profileFileName(result.profile));
    await writeFile(target, `${JSON.stringify(result.profile, null, 2)}\n`, "utf-8");
    console.log(`   → 已写入 ${target}\n`);
  }

  const written = results.filter((r) => !r.skipped).length;
  const infeasible = results.filter((r) => !r.skipped && r.skipReasons.length > 0).length;
  console.log(`完成：写出 ${written} 份 profile，跳过 ${results.length - written} 组。`);
  if (infeasible > 0) {
    console.log(`⚠️ 其中 ${infeasible} 份的产出**没满足业务约束**，请勿直接上线（见上）。`);
  }
  if (written === 0) {
    console.log(
      "提醒：本次没有任何 profile 写出。这是设计如此——样本不足时宁可不出阈值，" +
        "也不要产出一个看起来精确的数字，然后被当成跨模型跨领域的自然常数用。",
    );
  }
  return written === 0 && results.length > 0 ? 1 : 0;
}

// 仅在作为脚本直接运行时执行；被 import 时不执行（便于单测）
const invokedDirectly =
  process.argv[1] !== undefined &&
  /calibrate-threshold\.(ts|js|mts)$/.test(process.argv[1].replace(/\\/g, "/"));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error("标定失败：", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
