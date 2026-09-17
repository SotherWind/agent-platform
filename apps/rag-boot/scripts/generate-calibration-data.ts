/**
 * 生成构造标定数据：跑**真实**链路的分数，配**构造**的标签。
 *
 * 用法（cwd = apps/rag-boot）：
 *   pnpm synthetic:data
 *   pnpm synthetic:data -- --seed config/confidence/seed-queries.json --kb ../server/rag-bot/knowledge
 *
 * 产出：
 *   <out>/synthetic-<domain>.jsonl      标定数据（provenance=constructed）
 *   <out>/synthetic-manifest.json       数据集清单：地层构成、被剔除样本、诚实声明
 *
 * 这个脚本只做 I/O。切块、地层→标签、装配、体检都在 `src/confidence/synthetic.ts`（可单测）。
 *
 * 必须知道的边界：分数量纲是真的（真 embedding + 真 reranker + 真知识库），
 * 但标签是构造的、流行度是编的。所以产出只能当 provisional 先验，
 * 不能当实测标定——这一点由 profile schema 的守卫强制，不靠自觉。
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbeddings } from "../src/embeddings";
import { createApiReranker } from "../src/rerank";
import { decisionBand, describeBandStability, thresholdTradeoff } from "../src/confidence/margin";
import type { LabeledCaseWithChunks } from "../src/confidence/calibration";
import {
  buildSyntheticRecords,
  dominantRiskStratum,
  SeedQuerySetSchema,
  splitSections,
  validateSeedSet,
  type KbSection,
} from "../src/confidence/synthetic";
import type { RerankedChunk, RetrievedChunk } from "../src/type";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

interface CliOptions {
  seed: string;
  kb: string;
  out: string;
  topK: number;
  topN: number;
}

const USAGE =
  "用法: generate-calibration-data [--seed <seed.json>] [--kb <knowledge-dir>] [--out <dir>]\n" +
  "      [--top-k 20] [--top-n 5]";

function parseArgs(argv: string[]): CliOptions {
  // 默认值以**脚本自身位置**为基准，而不是 cwd——
  // 否则 `pnpm synthetic:data` 与直接 `tsx scripts/...` 会解析到不同目录，
  // 这类"相对谁"的错位在 CLI 里极容易发生且报错信息完全不指向真因。
  const here = dirname(fileURLToPath(import.meta.url));
  const pick = (value: string | undefined, fallbackAbs: string): string =>
    value === undefined ? fallbackAbs : isAbsolute(value) ? value : resolve(process.cwd(), value);

  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    seed: pick(get("--seed"), resolve(here, "../config/confidence/seed-queries.json")),
    kb: pick(get("--kb"), resolve(here, "../../../server/rag-bot/knowledge")),
    out: pick(get("--out"), resolve(here, "../../../tmp/synthetic-calibration")),
    topK: Number(get("--top-k") ?? 20),
    topN: Number(get("--top-n") ?? 5),
  };
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) * (a[i] as number);
    nb += (b[i] as number) * (b[i] as number);
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rerankerModel = process.env.RERANK_MODEL ?? "(unset)";
  if (!process.env.RERANK_API_KEY || !process.env.EMBEDDING_API_KEY) {
    throw new Error("缺少 RERANK_API_KEY / EMBEDDING_API_KEY，无法跑真实链路");
  }

  // ── 1) 知识库切块（与生产一致的参数） ────────────────────────────
  const files = readdirSync(options.kb).filter((name) => name.endsWith(".md"));
  const sections: KbSection[] = [];
  let oversizedSections = 0;
  for (const file of files) {
    const result = splitSections(file, readFileSync(`${options.kb}/${file}`, "utf8"));
    sections.push(...result.sections);
    oversizedSections += result.oversizedSections;
  }
  console.log(`知识库：${files.length} 篇 → ${sections.length} 个块`);

  // ── 2) 种子集体检（标签错了后面全白做） ──────────────────────────
  const set = SeedQuerySetSchema.parse(JSON.parse(readFileSync(options.seed, "utf8")));
  const validation = validateSeedSet(set, sections);
  for (const warning of validation.warnings) console.log(`⚠️  ${warning}`);
  if (validation.errors.length > 0) {
    for (const error of validation.errors) console.error(`❌ ${error}`);
    throw new Error(`种子集校验失败（${validation.errors.length} 项）`);
  }
  console.log(
    `种子集：${set.queries.length} 条` +
      `（可答 ${validation.byStratum.answerable} / 邻近缺参 ${validation.byStratum.near_miss} / 域外 ${validation.byStratum.out_of_scope}）`,
  );

  // ── 3) 真实 embedding ──────────────────────────────────────────
  const embeddings = createEmbeddings();
  const sectionVectors = await embeddings.embedDocuments(sections.map((s) => s.content));
  console.log(`已嵌入 ${sectionVectors.length} 个块`);

  // ── 4) 真实检索 + 真实 rerank ──────────────────────────────────
  const reranker = createApiReranker();
  const scores = new Map<string, number[]>();
  const retrieved = new Map<string, string[]>();

  for (const query of set.queries) {
    const [queryVector] = await embeddings.embedDocuments([query.q]);
    const candidates = sections
      .map((section, index) => ({ section, sim: cosine(queryVector as number[], sectionVectors[index] as number[]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, options.topK);

    const chunks: RetrievedChunk[] = candidates.map(({ section, sim }, index) => ({
      id: `c${index + 1}`,
      documentId: section.doc,
      tenantId: "tenant-synthetic",
      content: section.content,
      score: Number(sim.toFixed(6)),
      metadata: {},
    }));

    const reranked: RerankedChunk[] = await reranker.rerank(query.q, chunks, options.topN);

    scores.set(query.id, reranked.map((chunk) => chunk.rerankScore));
    // 用内容反查块 id，供「可答样本是否真的召回到目标」自检
    const contentToId = new Map(sections.map((s) => [s.content, s.id]));
    retrieved.set(
      query.id,
      reranked.map((chunk) => contentToId.get(chunk.content) ?? "(unknown)"),
    );
    console.log(
      `  ${query.id.padEnd(4)} top=${Math.max(...reranked.map((c) => c.rerankScore)).toFixed(4)}  ${query.q}`,
    );
  }

  // ── 5) 装配（纯函数）+ 决策带分析 ──────────────────────────────
  const { records, manifest } = buildSyntheticRecords({
    set,
    rerankerModel,
    scores,
    retrieved,
    sections,
    oversizedSections,
  });

  const cases: LabeledCaseWithChunks[] = records.map((record) => ({
    id: record.id,
    score: record.score,
    shouldEscalate: record.shouldEscalate,
    chunkScores: record.chunkScores,
  }));
  const strata = new Map(records.map((record) => [record.id, record.stratum]));
  const band = decisionBand(cases, strata);
  const tradeoff = thresholdTradeoff(cases);
  const risk = dominantRiskStratum(records);

  // ── 6) 落盘 ────────────────────────────────────────────────────
  mkdirSync(options.out, { recursive: true });
  const jsonlPath = resolve(options.out, `synthetic-${set.domain}.jsonl`);
  writeFileSync(
    jsonlPath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
  const manifestPath = resolve(options.out, "synthetic-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, band, tradeoff, dominantRisk: risk }, null, 2),
    "utf8",
  );

  // ── 7) 报告 ────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(78));
  console.log("构造数据集");
  console.log("=".repeat(78));
  console.log(
    `样本 ${manifest.total}（正类 ${manifest.positives} / 负类 ${manifest.negatives}），` +
      `正类占比 ${(manifest.positiveShare * 100).toFixed(1)}% —— **这个占比是构造的，不是线上分布**`,
  );
  console.log(
    `地层：可答 ${manifest.byStratum.answerable} / 邻近缺参 ${manifest.byStratum.near_miss} / 域外 ${manifest.byStratum.out_of_scope}`,
  );
  for (const warning of manifest.warnings) console.log(`⚠️  ${warning}`);

  console.log("\n" + "=".repeat(78));
  console.log("决策带（只依赖类内分布，与流行度无关 —— 所以这部分可以采信）");
  console.log("=".repeat(78));
  console.log(`      ${band.reason}`);
  console.log(`      带宽 ${band.width.toFixed(4)}   中点 ${band.midpoint ?? "n/a"}`);
  console.log(`      ${describeBandStability(band)}`);
  if (band.limiting.easiestPositive && band.limiting.hardestNegative) {
    console.log(
      `      最难的负样本：${band.limiting.hardestNegative.id}` +
        `（${band.limiting.hardestNegative.stratum ?? "-"}，top=${band.limiting.hardestNegative.topScore}）`,
    );
    console.log(
      `      最简单的正样本：${band.limiting.easiestPositive.id}` +
        `（${band.limiting.easiestPositive.stratum ?? "-"}，top=${band.limiting.easiestPositive.topScore}）`,
    );
  }
  if (risk) {
    console.log(`      风险主要来自 ${risk.stratum} 地层（${risk.id}，top=${risk.topScore}）`);
  }
  for (const inversion of band.inversions.slice(0, 5)) {
    console.log(
      `      ⚠️ 倒置：负样本 ${inversion.negativeId}(${inversion.negativeTop}) < 正样本 ${inversion.positiveId}(${inversion.positiveTop})`,
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("阈值取舍（tpr/fpr 都是类内比例，同样与流行度无关）");
  console.log("=".repeat(78));
  const interesting = tradeoff.filter((row) => row.tpr >= 0.9 || row.fpr > 0);
  for (const row of interesting) {
    console.log(
      `   τ=${String(row.threshold).padEnd(8)} 召回=${(row.tpr * 100).toFixed(1)}%` +
        `  误伤=${(row.fpr * 100).toFixed(1)}%  (tp=${row.tp}/${row.positives}, fp=${row.fp}/${row.negatives})`,
    );
  }
  const best = tradeoff
    .filter((row) => row.tpr === 1 && row.fpr === 0)
    .map((row) => row.threshold);
  if (best.length > 0) {
    console.log(
      `\n  当前 0.35 的对照：在可做到「召回 100% 且误伤 0%」的阈值区间里，最小的是 ${Math.min(...best)}`,
    );
    if (Math.min(...best) > 0.35) {
      console.log(`  → 0.35 低于这个下界，会把本数据中分数最高的正样本放行。`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("必须随数据一起移交的声明");
  console.log("=".repeat(78));
  for (const caveat of manifest.caveats) console.log(`  · ${caveat}`);

  console.log(`\n写入：${jsonlPath}`);
  console.log(`写入：${manifestPath}`);
  console.log(
    "\n下一步（注意产出会是 provisional，不是 calibrated）：\n" +
      `  pnpm calibrate --input ${jsonlPath} --out ${resolve(options.out, "profiles")} --min-sample 20`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
