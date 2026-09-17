/**
 * 用户模拟探针：模拟真实用户使用，能测出什么、不能测出什么。
 *
 * 跑法（cwd = apps/rag-boot）：
 *   pnpm probe:user-sim
 *   pnpm probe:user-sim -- --limit 12
 *
 * 设计要点（为什么这么做，而不是"让模拟用户打分"）：
 *
 * 1. **模拟用户只用于生成输入，不用于生成标签。**
 *    由知识库章节自指令合成"真实客户会问的问题"，解决种子集覆盖面窄的问题。
 *
 * 2. **标签来自答案消融，不来自任何模型判断。**
 *    同一个问题跑两遍：一遍保留承载答案的那一节，一遍把它从候选池里拿掉。
 *    于是自动得到成对的两类：
 *      - 保留 → 答得了（负类）
 *      - 消融 → 承载答案的那一节不可用（正类）
 *    这是**构造性真值**：消融是代码执行的事实，不是谁的意见。
 *
 * 3. **在被消融的上下文下让真模型作答，用确定性规则检查它有没有编数字。**
 *    产出"模拟用户会被误导的比例"——这是"模拟用户满意度不能当标签"的量化证据，
 *    而不是一句论断。注意生产 prompt 里**已经**写了"上下文未覆盖就不要编造"，
 *    所以这里测出的是**在明确禁止编造的前提下仍然编造**的比例。
 *
 * 边界：消融只保证"承载答案的那一节不可用"，不保证整库都没有答案（相邻节可能也含）。
 * 所以对答得出处的样本会单独报出来，作为"消融没击中、应剔除"的假负样本。
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbeddings } from "../src/embeddings";
import { createChatLlm } from "../src/llm/chat";
import { GENERATE_PROMPT, renderPrompt } from "../src/prompts";
import { createApiReranker } from "../src/rerank";
import { decisionBand, describeBandStability } from "../src/confidence/margin";
import {
  assessCoverage,
  compareJudges,
  type CoverageDecision,
  type CoverageResult,
} from "../src/confidence/coverage";
import { splitSections, type KbSection } from "../src/confidence/synthetic";
import {
  PERSONA_SPECS,
  baselineEvaluation,
  compareUserLabels,
  floorFromUserLabels,
  parseUserVerdict,
  userVerdictPrompt,
  USER_VERDICT_SYSTEM,
  type UserLabelCase,
  type UserPersona,
} from "../src/confidence/user-agent";
import {
  buildAblatedCases,
  checkSynthesis,
  classifyAnswerProbe,
  measureAblationResidue,
  measureKbRedundancy,
  parseSynthesizedQuestion,
  placeAgainstBand,
  questionSynthesisPrompt,
  summarizeProbe,
  QUESTION_SYNTHESIS_SYSTEM,
  type ProbeRow,
  type SynthesisCheck,
} from "../src/confidence/user-simulation";
import type { LabeledCaseWithChunks } from "../src/confidence/calibration";
import type { RerankedChunk, RetrievedChunk } from "../src/type";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

interface CliOptions {
  kb: string;
  out: string;
  topK: number;
  topN: number;
  limit: number;
  /** 被审视的阈值：统计有多少可答问题会被它判成低置信 */
  floor: number;
  /** 合成问题阶段很贵（每个章节一次 LLM 调用），默认复用缓存 */
  refresh: boolean;
  /** 只跑知识库冗余体检（不调任何模型），用于判断消融法在这份库上可不可用 */
  redundancyOnly: boolean;
  /** 只跑判据对比（不调模型）：floor 相似度阈值 vs 属性覆盖 */
  judgeCompare: boolean;
  /** 跑用户子智能体：真的开一个"不知道答案"的用户，并评估把它当标签的后果 */
  userAgent: boolean;
  /** 只重印用户子智能体报告（读已落盘的判定，不调模型） */
  replayUserAgent: boolean;
  /**
   * 结果文件名后缀，用于 A/B 对比时不覆盖基线。
   *
   * 例：`--tag qwen4b` 会把结果写成 `judge-compare-qwen4b.json`。
   * 没有这个后缀时换 reranker 重跑会**静默覆盖**上一次的结果，
   * 而那个文件正是你要拿来对比的基线——踩过一次就够了。
   */
  tag: string;
}

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const pick = (value: string | undefined, fallbackAbs: string): string =>
    value === undefined ? fallbackAbs : isAbsolute(value) ? value : resolve(process.cwd(), value);

  return {
    kb: pick(get("--kb"), resolve(here, "../../../server/rag-bot/knowledge")),
    out: pick(get("--out"), resolve(here, "../../../tmp/user-simulation-probe")),
    topK: Number(get("--top-k") ?? 20),
    topN: Number(get("--top-n") ?? 5),
    limit: Number(get("--limit") ?? 0),
    floor: Number(get("--floor") ?? 0.35),
    refresh: argv.includes("--refresh"),
    redundancyOnly: argv.includes("--redundancy-only"),
    judgeCompare: argv.includes("--judge-compare"),
    userAgent: argv.includes("--user-agent"),
    replayUserAgent: argv.includes("--replay-user-agent"),
    tag: get("--tag") ?? "",
  };
}

/** 结果文件名后缀；只影响产物名，不影响共享的合成问题缓存 */
const tagSuffix = (tag: string): string => (tag ? `-${tag.replace(/[^\w.-]+/g, "_")}` : "");

/** 一次调用失败不该让整轮实验白跑；只重试一次，避免把瞬时故障算成结论 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.log(`  ↻ ${label} 首次失败，重试一次：${error instanceof Error ? error.message : String(error)}`);
    return fn();
  }
}

interface CachedQuestion {
  sectionId: string;
  question: string;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * 打印用户子智能体报告。
 *
 * 与"采集"分开是刻意的：报告措辞改一次就要重跑两百次模型调用是不可接受的，
 * 而且报告改错（比如把"选不出阈值"印成"漏放 100%"）会被当成结论读走。
 * 采集结果落盘后 `--replay-user-agent` 可以零成本重印。
 */
function printUserAgentReport(
  cases: UserLabelCase[],
  options: { floor: number; out: string; jsonPath: string },
): void {
  const agreements = compareUserLabels(cases);
  const derived = floorFromUserLabels(cases);
  const baseline = baselineEvaluation(cases, { floor: options.floor });
  const misses = cases
    .filter((row) => row.shouldEscalate && row.verdict.answered)
    .map((row) => ({
      question: row.question,
      answer: row.answer.replace(/\s+/g, " ").slice(0, 180),
      reason: row.verdict.reason,
    }));

  console.log("\n" + "=".repeat(78));
  console.log(`用户子智能体（不知道答案，只看得到回答本身）。样本 ${cases.length} 条`);
  console.log("=".repeat(78));
  console.log("  人格        答不了却说「答上了」     答得了却说「没答上」    与真值一致率");
  for (const a of agreements) {
    console.log(
      `  ${PERSONA_SPECS[a.persona].label.padEnd(8)}` +
        `${String(a.reportedAnsweredOnUnanswerable).padStart(4)}/${String(a.unanswerableTotal).padEnd(3)} (${pct(a.reportedAnsweredOnUnanswerableRate).padStart(6)})   ` +
        `${String(a.reportedUnansweredOnAnswerable).padStart(4)}/${String(a.answerableTotal).padEnd(3)} (${pct(a.reportedUnansweredOnAnswerableRate).padStart(6)})   ` +
        `${pct(a.agreementOnAnswered).padStart(6)}`,
    );
  }
  console.log(
    "\n  第一列就是关键：**知识库明明给不出答案，用户子智能体却说「答上了」**。" +
      "那就是把用户判断当标签时的漏标率，而它漏掉的正是闸门存在的理由。",
  );
  console.log(
    "  两个人格要一起读：挑剔人格的漏标更低，但它是靠被明确要求核对",
  );
  console.log(
    "  「有没有正面回答你问的那件事」做到的——**那时它已经是个评委，不是用户**；" +
      "代价是反过来把 15% 的答得了判成没答上。真实客户不会逐句核对。",
  );

  console.log("\n" + "=".repeat(78));
  console.log("照提案的做法：拿用户判断当标签选阈值，再拿回构造真值评估");
  console.log("=".repeat(78));
  console.log(
    `  现役基线（floor=${options.floor}）：` +
      `误伤 ${baseline.falseAlarm} (${pct(baseline.falseAlarmRate)})   漏放 ${baseline.missed} (${pct(baseline.missRate)})`,
  );
  for (const item of derived) {
    if (item.derivedFloor === null) {
      // 措辞必须准确：这不是"漏放 100%"，而是**根本没有产出阈值**
      console.log(
        `  ${PERSONA_SPECS[item.persona].label.padEnd(8)} **选不出阈值**（可行区间宽度 ${item.band.width.toFixed(4)} ≤ 0）`,
      );
      console.log(`            ${item.band.reason}`);
      console.log(
        `            注：若硬把"不产出阈值"当成"什么都不拦"，那等价于漏放 ${item.evaluation.missed}/${item.evaluation.missesAllowed}；` +
          "但正确的读法是**这套标签导不出可用的阈值**。",
      );
    } else {
      console.log(
        `  ${PERSONA_SPECS[item.persona].label.padEnd(8)} 选出 floor=${item.derivedFloor}` +
          `（可行区间宽 ${item.band.width.toFixed(4)}）→ 误伤 ${item.evaluation.falseAlarm} (${pct(item.evaluation.falseAlarmRate)})` +
          `  漏放 ${item.evaluation.missed} (${pct(item.evaluation.missRate)})`,
      );
    }
  }

  console.log("\n  用户觉得「答上了」、但知识库给不出答案的样本——用户看到的是一段笃定回答：");
  for (const miss of misses.slice(0, 4)) {
    console.log(`\n    Q: ${miss.question}`);
    console.log(`    A: ${miss.answer}…`);
    console.log(`    用户的理由：${miss.reason}`);
  }

  console.log(`\n采集结果：${options.jsonPath}`);
}


/** 合成阶段每章节一次 LLM 调用，很贵；缓存到磁盘，重跑实验与判据对比都不必重付 */
function readSynthesisCache(outDir: string): CachedQuestion[] {
  try {
    return JSON.parse(readFileSync(resolve(outDir, "synthesized.json"), "utf8")) as CachedQuestion[];
  } catch {
    return [];
  }
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
  if (!process.env.MODEL_API_KEY || !process.env.RERANK_API_KEY || !process.env.EMBEDDING_API_KEY) {
    throw new Error("缺少 MODEL_API_KEY / RERANK_API_KEY / EMBEDDING_API_KEY，无法跑探针");
  }
  const rerankerModel = process.env.RERANK_MODEL ?? "(unset)";

  // ── 1) 知识库 ──────────────────────────────────────────────────
  mkdirSync(options.out, { recursive: true });
  const files = readdirSync(options.kb).filter((name) => name.endsWith(".md"));
  const sections: KbSection[] = [];
  for (const file of files) {
    sections.push(...splitSections(file, readFileSync(`${options.kb}/${file}`, "utf8")).sections);
  }
  const trimmed =
    options.limit > 0 ? sections.slice(0, options.limit) : sections;
  console.log(`知识库：${files.length} 篇 → ${sections.length} 个块，本次探测 ${trimmed.length} 个`);

  if (options.redundancyOnly) {
    const report = measureKbRedundancy(trimmed);
    console.log("\n" + "=".repeat(78));
    console.log("知识库冗余体检（纯确定性，不调模型）");
    console.log("=".repeat(78));
    console.log(
      `  ${report.redundantSections}/${report.sectionCount} 个章节` +
        `（${(report.redundantShare * 100).toFixed(1)}%）的内容在**其余章节**里也能找到大半。`,
    );
    console.log("  残留度 = 该章节有多少比例的句子在别处照样找得到出处（6 字 n-gram 匹配）。");
    console.log("");
    for (const item of report.items) {
      const bar = "█".repeat(Math.round(item.residueShare * 20)).padEnd(20, "·");
      console.log(`  ${bar} ${(item.residueShare * 100).toFixed(0).padStart(3)}%  ${item.id}`);
    }
    console.log(
      "\n  读法：冗余高说明 ① 章节级消融造不出有效负样本；" +
        "② 一个问题即使库里没有答案，检索也总能捞到写法相近的邻居——" +
        "群像式幻觉的温床在知识库组织方式里，不只是阈值的事。",
    );
    return;
  }

  // 只重印报告：必须放在**任何网络调用之前**。
  // 之前把它放在批量嵌入之后，结果 embedding 一 402（余额不足）连报告都印不出来——
  // 而重印报告本来不需要任何外部依赖。
  if (options.replayUserAgent) {
    const jsonPath = resolve(options.out, `user-agent${tagSuffix(options.tag)}.json`);
    const saved = JSON.parse(readFileSync(jsonPath, "utf8")) as { cases: UserLabelCase[] };
    console.log(`复用已保存的判定 ${saved.cases.length} 条（来自 ${jsonPath}）`);
    printUserAgentReport(saved.cases, { ...options, jsonPath });
    return;
  }

  const embeddings = createEmbeddings();
  const sectionVectors = await embeddings.embedDocuments(trimmed.map((s) => s.content));

  const llm = createChatLlm({
    // model 是必填项：不传会退到 SDK 默认的 gpt-3.5-turbo，而本项目网关没有这个模型
    model: process.env.MODEL_NAME ?? (() => {
      throw new Error("缺少 MODEL_NAME，无法确定要调哪个模型");
    })(),
    tier: "small",
    maxTokens: 600,
    // 作答时要带上 5 段上下文，默认 30s 不够，实测偶发超时
    timeoutMs: 120_000,
  });
  const reranker = createApiReranker();

  /** 给定候选块集合，检索+重排，返回 (重排结果, 块 id 顺序, 分数) */
  const retrieveAndRerank = async (
    query: string,
    pool: number[],
    contentToId: Map<string, string>,
  ): Promise<{ reranked: RerankedChunk[]; rankedIds: string[]; topScore: number }> => {
    const [queryVector] = await embeddings.embedDocuments([query]);
    const candidates = pool
      .map((index) => ({
        section: trimmed[index] as KbSection,
        sim: cosine(queryVector as number[], sectionVectors[index] as number[]),
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, options.topK);

    const chunks: RetrievedChunk[] = candidates.map(({ section, sim }, index) => ({
      id: `c${index + 1}`,
      documentId: section.doc,
      tenantId: "tenant-probe",
      content: section.content,
      score: Number(sim.toFixed(6)),
      metadata: {},
    }));
    const reranked = await withRetry("rerank", () => reranker.rerank(query, chunks, options.topN));
    return {
      reranked,
      rankedIds: reranked.map((chunk) => contentToId.get(chunk.content) ?? "(unknown)"),
      topScore: reranked.length === 0 ? 0 : Math.max(...reranked.map((c) => c.rerankScore)),
    };
  };

  const contentToId = new Map(trimmed.map((s) => [s.content, s.id]));
  const allIds = trimmed.map((s) => s.id);
  const poolAll = trimmed.map((_, index) => index);

  // 判据对比模式：只做检索+重排（不调模型），对比"topScore 阈值"与"属性覆盖"两种判据
  if (options.judgeCompare) {
    const cache = readSynthesisCache(options.out);
    if (cache.length === 0) {
      throw new Error(`没有可用的合成问题缓存（${options.out}/synthesized.json），先跑一次完整探针`);
    }

    const rows: Array<{ decision: CoverageDecision; shouldEscalate: boolean }> = [];
    const details: Array<Record<string, unknown>> = [];

    for (const [index, item] of cache.entries()) {
      const sourceIndex = trimmed.findIndex((s) => s.id === item.sectionId);
      if (sourceIndex < 0) continue;

      // 可答：承载答案的那一节在场
      const full = await retrieveAndRerank(item.question, poolAll, contentToId);
      const fullContext = full.reranked.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
      const fullCoverage = assessCoverage(item.question, fullContext);

      // 答不了：把它拿掉（同时做残留度筛查，残留过高不算有效消融）
      const keptIndexes = poolAll.filter((i) => i !== sourceIndex);
      const residue = measureAblationResidue(
        trimmed[sourceIndex]!.content,
        keptIndexes.map((i) => trimmed[i]!.content),
        item.sectionId,
      );
      const abl = await retrieveAndRerank(item.question, keptIndexes, contentToId);
      const ablContext = abl.reranked.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
      const ablCoverage = assessCoverage(item.question, ablContext);

      const decisionOf = (
        id: string,
        topScore: number,
        coverage: CoverageResult,
      ): CoverageDecision => ({
        id,
        question: item.question,
        topScore: Number(topScore.toFixed(4)),
        oldFlags: topScore < options.floor,
        // 判不了就返回 null（不表态），对比时回落旧判据——不让弃权把数字做好看
        newFlags: coverage.assessable ? coverage.insufficient : null,
        coverage,
      });

      if (residue.valid) {
        rows.push({
          decision: decisionOf(`full-${index}`, full.topScore, fullCoverage),
          shouldEscalate: false,
        });
        rows.push({
          decision: decisionOf(`abl-${index}`, abl.topScore, ablCoverage),
          shouldEscalate: true,
        });
      }

      details.push({
        sectionId: item.sectionId,
        question: item.question,
        residueValid: residue.valid,
        fullTopScore: Number(full.topScore.toFixed(4)),
        ablTopScore: Number(abl.topScore.toFixed(4)),
        fullCoverage: fullCoverage.assessable ? fullCoverage.assessed : "not-assessable",
        ablCoverage: ablCoverage.assessable ? ablCoverage.assessed : "not-assessable",
      });
    }

    const comparison = compareJudges(rows);
    const jsonPath = resolve(options.out, `judge-compare${tagSuffix(options.tag)}.json`);
    writeFileSync(jsonPath, JSON.stringify({ floor: options.floor, comparison, details }, null, 2), "utf8");

    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    console.log("\n" + "=".repeat(78));
    console.log(`判据对比（不调模型）：floor=${options.floor} 的相似度阈值 vs 属性覆盖。n=${comparison.total}`);
    console.log("=".repeat(78));
    console.log(`      新判据可表态的样本：${comparison.assessable}/${comparison.total}` +
      `（弃权 ${pct(comparison.abstainRate)}，弃权按回落旧判据计）`);
    console.log("");
    console.log("      判据          误伤(可答被判低置信)      漏放(答不了却放行)");
    console.log(
      `      相似度阈值    ${String(comparison.old.falseAlarm).padStart(3)} (${pct(comparison.old.falseAlarmRate).padStart(6)})          ` +
        `${String(comparison.old.missed).padStart(3)} (${pct(comparison.old.missRate).padStart(6)})`,
    );
    console.log(
      `      属性覆盖      ${String(comparison.new.falseAlarm).padStart(3)} (${pct(comparison.new.falseAlarmRate).padStart(6)})          ` +
        `${String(comparison.new.missed).padStart(3)} (${pct(comparison.new.missRate).padStart(6)})`,
    );

    console.log("\n      逐条看判据分歧（新判据与旧判据结论不同的样本）：");
    let shown = 0;
    for (const row of details) {
      const full = row.fullCoverage;
      const abl = row.ablCoverage;
      const fullFlag = (row.fullTopScore as number) < options.floor;
      const ablFlag = (row.ablTopScore as number) < options.floor;
      const fullNew = Array.isArray(full) ? full.some((a) => a.verdict === "unsupported") : null;
      const ablNew = Array.isArray(abl) ? abl.some((a) => a.verdict === "unsupported") : null;
      if (fullFlag === fullNew && ablFlag === ablNew) continue;
      shown += 1;
      if (shown > 12) continue;
      console.log(`\n        ${row.sectionId}`);
      console.log(`          「${row.question}」`);
      console.log(
        `          可答: top=${row.fullTopScore} 旧判${fullFlag ? "低置信" : "放行"}` +
          ` → 新判${fullNew === null ? "弃权" : fullNew ? "覆盖不足" : "覆盖充分"}`,
      );
      console.log(
        `          消融: top=${row.ablTopScore} 旧判${ablFlag ? "低置信" : "放行"}` +
          ` → 新判${ablNew === null ? "弃权" : ablNew ? "覆盖不足" : "覆盖充分"}`,
      );
    }
    if (shown === 0) console.log("        （无分歧）");

    console.log(`\n明细写入：${jsonPath}`);
    return;
  }

  // 用户子智能体模式：真的开一个"不知道答案"的用户，再把它当标签看后果
  if (options.userAgent) {
    const jsonPath = resolve(options.out, `user-agent${tagSuffix(options.tag)}.json`);
    const personas: UserPersona[] = ["plain", "skeptical"];
    const cases: UserLabelCase[] = [];

    const cache = readSynthesisCache(options.out);
    if (cache.length === 0) {
      throw new Error(`没有可用的合成问题缓存（${options.out}/synthesized.json），先跑一次完整探针`);
    }

    for (const [index, item] of cache.entries()) {
      const sourceIndex = trimmed.findIndex((s) => s.id === item.sectionId);
      if (sourceIndex < 0) continue;

      // 与判据对比一致：重复内容过高的章节消融无效，跳过
      const residue = measureAblationResidue(
        trimmed[sourceIndex]!.content,
        poolAll.filter((i) => i !== sourceIndex).map((i) => trimmed[i]!.content),
        item.sectionId,
      );
      if (!residue.valid) continue;

      const answerFor = async (indexes: number[]) => {
        const { reranked, topScore } = await retrieveAndRerank(item.question, indexes, contentToId);
        const context = reranked.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
        const response = await withRetry(`作答`, () =>
          llm.invoke({
            system: renderPrompt(GENERATE_PROMPT, {
              tenantId: "tenant-probe",
              context,
              confidenceNote: "",
            }),
            prompt: item.question,
            temperature: 0.2,
            maxTokens: 500,
            stage: "user-agent-answer",
          }),
        );
        return { topScore, answer: response.text.trim() };
      };

      const full = await answerFor(poolAll);
      const abl = await answerFor(poolAll.filter((i) => i !== sourceIndex));

      for (const persona of personas) {
        for (const [suffix, outcome, shouldEscalate] of [
          ["full", full, false],
          ["abl", abl, true],
        ] as const) {
          const raw = await withRetry(`用户判断`, () =>
            llm.invoke({
              system: USER_VERDICT_SYSTEM,
              prompt: userVerdictPrompt({
                persona,
                question: item.question,
                answer: outcome.answer,
              }),
              temperature: 0.2,
              maxTokens: 300,
              json: true,
              stage: "user-agent-verdict",
            }),
          );
          const verdict = parseUserVerdict(raw.text);
          if (!verdict) {
            console.log(`  ⚠️ 用户判断解析失败，跳过：${item.sectionId} / ${persona} / ${suffix}`);
            continue;
          }
          cases.push({
            id: `${index}-${suffix}`,
            question: item.question,
            shouldEscalate,
            topScore: Number(outcome.topScore.toFixed(4)),
            answer: outcome.answer,
            persona,
            verdict,
          });
        }
      }
      console.log(`  ✓ ${item.sectionId}`);
    }

    writeFileSync(jsonPath, JSON.stringify({ floor: options.floor, cases }, null, 2), "utf8");
    printUserAgentReport(cases, { ...options, jsonPath });
    return;
  }

  // ── 2) 合成问题 + 全库校验（一次批量嵌入查询） ──────────────────
  console.log("\n阶段一：由章节合成真实感问题，并用全库检索校验「问题 ↔ 章节」是否对得上");
  const checks: SynthesisCheck[] = [];
  const withSourceScore = new Map<string, number>();
  let synthesisFailed = 0;

  // 合成阶段每章节一次 LLM 调用，很贵；缓存到磁盘，重跑实验不必重付。
  // 失败/不合规的章节不写缓存（下次可以重试），避免一次抽风被永久固化。
  const cachePath = resolve(options.out, "synthesized.json");
  const cache = new Map<string, string>(
    (options.refresh ? [] : readSynthesisCache(options.out)).map((item) => [
      item.sectionId,
      item.question,
    ]),
  );
  if (cache.size > 0) {
    console.log(`  复用已缓存的合成问题 ${cache.size} 条（--refresh 可重跑）`);
  }

  const synthesized: Array<{ section: KbSection; question: string }> = [];
  for (const section of trimmed) {
    const cached = cache.get(section.id);
    if (cached) {
      synthesized.push({ section, question: cached });
      continue;
    }
    let parsed: ReturnType<typeof parseSynthesizedQuestion> = null;
    try {
      const response = await withRetry(`合成 ${section.id}`, () =>
        llm.invoke({
          system: QUESTION_SYNTHESIS_SYSTEM,
          prompt: questionSynthesisPrompt(section),
          temperature: 0.7,
          maxTokens: 120,
          stage: "probe-synthesize",
        }),
      );
      parsed = parseSynthesizedQuestion(response.text, section.id);
    } catch (error) {
      synthesisFailed += 1;
      console.log(`  ⚠️ 合成调用失败，跳过：${section.id}（${error instanceof Error ? error.message.slice(0, 80) : ""}）`);
      continue;
    }
    if (!parsed) {
      synthesisFailed += 1;
      console.log(`  ⚠️ 合成失败/不合规，跳过：${section.id}`);
      continue;
    }
    synthesized.push({ section, question: parsed.question });
  }
  writeFileSync(
    cachePath,
    JSON.stringify(
      synthesized.map(({ section, question }) => ({ sectionId: section.id, question })),
      null,
      2,
    ),
    "utf8",
  );

  for (const { section, question } of synthesized) {
    const { rankedIds, topScore } = await retrieveAndRerank(question, poolAll, contentToId);
    const check = checkSynthesis(section.id, question, rankedIds);
    checks.push(check);
    if (check.valid) {
      withSourceScore.set(section.id, topScore);
      console.log(`  ✓ ${section.id}  top=${topScore.toFixed(4)}  「${question}」`);
    } else {
      console.log(`  ✗ ${section.id}  ${check.reason}  「${question}」`);
    }
  }

  const valid = checks.filter((c) => c.valid);
  const topOne = valid.filter((c) => c.topOne).length;
  console.log(
    `\n合成 ${synthesized.length} 条，校验通过 ${valid.length} 条（其中排第一 ${topOne} 条）` +
      `；丢弃 ${synthesized.length - valid.length} + 合成失败 ${synthesisFailed}`,
  );
  console.log(
    "  丢掉的那些多半不是模型写错了，而是知识库同一篇里相邻章节互相竞争" +
      "（问「价保周期」时「价保范围」也高度相关）——这本身就说明 chunk 级答案归属是模糊的。",
  );
  if (valid.length === 0) throw new Error("没有任何通过校验的样本，无法继续");

  // ── 3) 消融有效性筛查 + 作答探测 ──────────────────────────────
  console.log("\n阶段二：残留度筛查（确定性）+ 消融 → 难负样本分数 + 让真模型在被消融上下文下作答");

  // 知识库冗余画像：这既是消融能不能用的前提，本身也是个该被看见的结论
  const redundancy = measureKbRedundancy(trimmed);
  console.log(
    `\n  知识库冗余画像：${redundancy.redundantSections}/${redundancy.sectionCount} 个章节` +
      `（${(redundancy.redundantShare * 100).toFixed(0)}%）的内容在别处也能找到大部分`,
  );
  for (const item of redundancy.items.slice(0, 5)) {
    console.log(`     ${(item.residueShare * 100).toFixed(0)}%  ${item.id}`);
  }

  const cases = buildAblatedCases(checks, allIds);
  const rows: ProbeRow[] = [];
  let droppedByResidue = 0;

  for (const probeCase of cases) {
    const removed = trimmed.find((s) => s.id === probeCase.removedSectionId);
    if (!removed) continue;
    const remainingContents = trimmed
      .filter((s) => probeCase.remainingSectionIds.includes(s.id))
      .map((s) => s.content);

    // 先用确定性残留度判断"消融到底有没有把答案拿掉"——不通过的直接丢弃，
    // 不浪费一次作答调用，更不会把错标的正类混进决策带
    const residue = measureAblationResidue(
      removed.content,
      remainingContents,
      probeCase.removedSectionId,
    );
    if (!residue.valid) {
      droppedByResidue += 1;
      console.log(`  ⤫ ${probeCase.id} ${probeCase.removedSectionId} 残留 ${(residue.residueShare * 100).toFixed(0)}%，丢弃`);
      continue;
    }

    const keptIndexes = trimmed
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => probeCase.remainingSectionIds.includes(section.id))
      .map(({ index }) => index);

    const { reranked, topScore } = await retrieveAndRerank(
      probeCase.question,
      keptIndexes,
      contentToId,
    );

    const contextText = reranked
      .map((chunk, index) => `[${index + 1}] ${chunk.content}`)
      .join("\n\n");
    const answer = await withRetry(`作答 ${probeCase.id}`, () =>
      llm.invoke({
        system: renderPrompt(GENERATE_PROMPT, {
          tenantId: "tenant-probe",
          context: contextText,
          // 刻意不加低置信提示：要测的是"闸门未拦下时会发生什么"
          confidenceNote: "",
        }),
        prompt: probeCase.question,
        temperature: 0.2,
        maxTokens: 500,
        stage: "probe-answer",
      }),
    );

    const probe = classifyAnswerProbe(answer.text, contextText);
    rows.push({
      id: probeCase.id,
      question: probeCase.question,
      removedSectionId: probeCase.removedSectionId,
      topScore: Number(topScore.toFixed(4)),
      sourceScoreWhenPresent: Number(
        (withSourceScore.get(probeCase.removedSectionId) ?? 0).toFixed(4),
      ),
      probe,
      answer: answer.text.trim(),
    });

    const flag = probe.misleadsStrict
      ? "❗具体编造"
      : probe.producedAnswer
        ? "❗给了回答"
        : "✅承认不知道";
    console.log(
      `  ${flag} ${probeCase.id}  消融后 top=${topScore.toFixed(4)}  无出处数字=[${probe.ungroundedFigures.join(",")}]`,
    );
  }

  // ── 4) 成对决策带：同一个问题，保留 vs 消融 ────────────────────
  if (rows.length === 0) {
    console.log(
      "\n所有消融样本都被残留度筛查判为无效——说明这份知识库在别处重复写了同样的内容，" +
        "章节级消融造不出负样本。这不是失败，是结论：消融法不适用于这份库的组织方式。",
    );
    return;
  }
  const answerable = rows.map((row) => row.sourceScoreWhenPresent ?? 0);

  /**
   * 本实验最硬的一个数：**可答问题被默认阈值误伤的比例**。
   *
   * 这里的"可答"标签是构造出来的、不含任何模型判断——承载答案的那一节就在候选池里，
   * 而且全库检索时它排在前三。所以这批样本上判低置信，就是纯粹的误伤。
   * 它不受"消融是否击中答案"这个噪声的影响，因此比决策带更可信。
   */
  const falseAlarms = answerable.filter((score) => score < options.floor);
  const falseAlarmRate = answerable.length === 0 ? 0 : falseAlarms.length / answerable.length;

  const casesForBand: LabeledCaseWithChunks[] = [
    // 负类：承载答案的那一节在场 → 答得了
    ...rows.map((row) => ({
      id: `keep-${row.id}`,
      score: row.sourceScoreWhenPresent ?? 0,
      shouldEscalate: false,
      chunkScores: [row.sourceScoreWhenPresent ?? 0],
    })),
    // 正类：那一节被消融 → 知识库给不出答案
    ...rows.map((row) => ({
      id: `abl-${row.id}`,
      score: row.topScore,
      shouldEscalate: true,
      chunkScores: [row.topScore],
    })),
  ];
  const band = decisionBand(casesForBand);
  const placement = placeAgainstBand(
    rows.map((row) => ({ id: row.id, topScore: row.topScore })),
    band,
  );
  const summary = summarizeProbe(rows);

  /**
   * 干净子集上的决策带。
   *
   * 正类只保留**模型自认找不到依据**的那些——它们的"答不了"由模型自己确认，
   * 不依赖我对消融是否击中的判断。负类全部保留（可答标签本来就是构造的，已核实）。
   *
   * 这一步的作用是**只用于确认、不用于定标签**：正类标签仍然来自消融这个构造事实，
   * `admitsIgnorance` 只是把可疑样本去掉。去掉之后就没人能说"带撑破是因为你正类标错了"。
   */
  const confirmed = rows.filter((row) => row.probe.admitsIgnorance);
  const confirmedBand =
    confirmed.length > 0
      ? decisionBand([
          ...rows.map((row) => ({
            id: `keep-${row.id}`,
            score: row.sourceScoreWhenPresent ?? 0,
            shouldEscalate: false,
            chunkScores: [row.sourceScoreWhenPresent ?? 0],
          })),
          ...confirmed.map((row) => ({
            id: `conf-${row.id}`,
            score: row.topScore,
            shouldEscalate: true,
            chunkScores: [row.topScore],
          })),
        ])
      : null;

  // ── 5) 报告 ───────────────────────────────────────────────────
  mkdirSync(options.out, { recursive: true });
  const jsonPath = resolve(options.out, "probe.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        rerankerModel,
        llm: llm.model,
        floor: options.floor,
        droppedByResidue,
        redundancy,
        answerableSpread: {
          min: Math.min(...answerable),
          max: Math.max(...answerable),
          belowFloor: falseAlarms.length,
          rate: Number(falseAlarmRate.toFixed(4)),
        },
        band,
        confirmedBand,
        confirmedPositiveCount: confirmed.length,
        placement,
        summary,
        rows,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("\n" + "=".repeat(78));
  console.log("一、模拟真实措辞之后才看见的事：可答问题被误伤的比例");
  console.log("=".repeat(78));
  console.log(
    `      有效消融样本 ${rows.length} 条` +
      (droppedByResidue > 0 ? `（因知识库重复内容丢弃 ${droppedByResidue} 条）` : ""),
  );
  console.log(
    `      可答问题的 topScore 跨度：${Math.min(...answerable).toFixed(4)} ~ ${Math.max(...answerable).toFixed(4)}`,
  );
  console.log(
    `      **其中低于 floor=${options.floor} 的：${falseAlarms.length}/${answerable.length}` +
      ` = ${(falseAlarmRate * 100).toFixed(1)}%**`,
  );
  console.log("      这些问题的答案**确实在知识库里**，承载它的章节在全库检索时还排前三——");
  console.log(`      判它们低置信是纯粹的误伤，会变成没必要的兜底话术或转人工。`);
  console.log(
    `\n      对照：此前手写的 12 条可答种子（措辞偏书面）**全部** ≥ 0.4767，一条都没被误伤。`,
  );
  console.log(
    `      差别不在内容而在**措辞**——所以 floor 实际上主要在衡量"用户问得像不像文档"，`,
  );
  console.log(`      而不是"知识库答不答得了"。这一点只有模拟真实措辞才测得出来。`);

  console.log("\n" + "=".repeat(78));
  console.log("二、决策带（成对设计，标签来自消融）");
  console.log("=".repeat(78));
  console.log(`      ${band.reason}`);
  console.log(`      带宽 ${band.width.toFixed(4)}   中点 ${band.midpoint ?? "n/a"}`);
  console.log(`      ${describeBandStability(band)}`);
  console.log(
    `\n      消融样本分数落位：带下方 ${placement.belowBand} / 带内 ${placement.insideBand} / 带上方 ${placement.aboveBand}`,
  );
  if (placement.breakers.length > 0) {
    console.log(
      `      ⚠️ ${placement.breakers.length} 条消融样本的分数高于「最简单的可答样本」：`,
    );
    for (const breaker of placement.breakers.slice(0, 8)) {
      console.log(`         ${breaker.id}  top=${breaker.topScore}`);
    }
  }
  if (confirmedBand) {
    console.log(
      `\n      干净子集复核（正类只留模型自认找不到依据的 ${confirmed.length} 条，负类仍 ${rows.length} 条）：`,
    );
    console.log(`        ${confirmedBand.reason}`);
    console.log(
      `        → ${
        confirmedBand.separable
          ? `带宽 ${confirmedBand.width.toFixed(4)}`
          : "**仍然不可分**。两侧标签都经过核实，所以这不是标注噪声造成的"
      }`,
    );
  }
  console.log(
    `\n      ⚠️ 消融拿掉的是"承载答案的那一节"，不保证整库都答不了（相邻章节可能给出部分答案）。`,
  );
  console.log(`      所以正类标签有噪声，故上面额外做了干净子集复核。`);

  console.log("\n" + "=".repeat(78));
  console.log("三、模拟用户测不出来的：它自己会不会被误导");
  console.log("=".repeat(78));
  console.log(
    `      承认「知识库里没有依据」：${summary.admittedIgnorance}/${summary.total}` +
      ` = ${(summary.admitsRate * 100).toFixed(1)}%`,
  );
  console.log(
    `      **主指标**：没承认、而是给出了一段回答：${summary.didNotAdmit}/${summary.total}` +
      ` = ${(summary.didNotAdmitRate * 100).toFixed(1)}%`,
  );
  console.log(
    `      其中编造了无出处的具体数字：${summary.misledStrict}/${summary.total}` +
      ` = ${(summary.misledStrictRate * 100).toFixed(1)}%`,
  );
  console.log(
    `\n      注意：生产 prompt 里已经写明「上下文未覆盖的内容…不要编造」，` +
      `所以上面的比例是**在明确禁止编造的前提下仍然发生**的比例。`,
  );
  console.log(
    `      也注意主指标为什么不是"有没有编数字"：多数给出回答的情况是**拿邻章内容去答了另一个问题**`,
  );
  console.log(`      （数字全部有出处），只盯数字会几乎全部漏掉。`);
  console.log(
    `\n      → 这 ${(summary.didNotAdmitRate * 100).toFixed(1)}% 的样本上，模拟用户读到的是一段笃定回答，` +
      `它会说「解决了」。`,
  );
  console.log(`      而那句话对应的标签（"知识库答得了"）是**错的**。`);

  console.log("\n" + "=".repeat(78));
  console.log("四、所以结论");
  console.log("=".repeat(78));
  console.log("      模拟用户能做的：① 生成真实措辞的输入——第一栏那个误伤率就是它的产出，");
  console.log("      手写种子集完全测不到；② 用消融造标签，标签不来自模型判断。");
  console.log("      模拟用户不能做的：当标签。它的满意度对「流畅的编造」是免疫的，");
  console.log("      而这恰好是闸门存在的唯一理由——所以拿它当标签是有方向的偏差，比没有标签更糟。");

  console.log(`\n结果写入：${jsonPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
