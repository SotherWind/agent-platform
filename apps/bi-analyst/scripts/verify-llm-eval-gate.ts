/**
 * 真实 LLM evaluation 门禁（可选）。
 *
 * 默认：
 * - 始终跑离线 Text-to-SQL accuracy（mock 生成器）保证套件与打分器可用
 * - 未设置 ENABLE_LIVE_LLM_EVAL=1 时跳过真实模型调用
 *
 * live：
 * - ENABLE_LIVE_LLM_EVAL=1 且配置 MODEL_API_KEY（或 OPENAI_API_KEY / LLM_API_KEY）
 * - 调用真实 generate_sql 对照 golden 打分（阈值 LLM_EVAL_MIN_PASS_RATE，默认 0.67）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

async function main() {
  const {
    runTextToSqlAccuracyEval,
    createLiveSqlGenerator,
  } = await import("../src/evaluation/text-to-sql-eval.js");

  const offline = await runTextToSqlAccuracyEval();
  console.info(
    "[verify:llm-eval] offline",
    JSON.stringify(
      {
        cases: offline.report.cases,
        passed: offline.report.passed,
        passRate: offline.report.passRate,
        failed: offline.report.results
          .filter((r) => !r.passed)
          .map((r) => r.id),
      },
      null,
      2,
    ),
  );
  if (!offline.ok) {
    console.error("[verify:llm-eval] 离线 Text-to-SQL 套件未通过");
    process.exit(1);
  }

  if (process.env.ENABLE_LIVE_LLM_EVAL !== "1") {
    if (process.env.REQUIRE_LIVE_LLM_EVAL === "1") {
      console.error(
        "[verify:llm-eval] REQUIRE_LIVE_LLM_EVAL=1 but live evaluation is disabled",
      );
      process.exit(1);
    }
    console.info(
      "[verify:llm-eval] live skipped（设置 ENABLE_LIVE_LLM_EVAL=1 启用真实模型评测）",
    );
    process.exit(0);
  }

  const apiKey =
    process.env.MODEL_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.LLM_API_KEY?.trim() ||
    "";
  if (!apiKey) {
    console.error(
      "[verify:llm-eval] 缺少 MODEL_API_KEY / OPENAI_API_KEY / LLM_API_KEY",
    );
    process.exit(1);
  }

  const minPassRate = Number(process.env.LLM_EVAL_MIN_PASS_RATE ?? "0.85");
  const generateSql = await createLiveSqlGenerator();
  const live = await runTextToSqlAccuracyEval({
    generateSql,
    minPassRate,
  });

  console.info(
    "[verify:llm-eval] live",
    JSON.stringify(
      {
        cases: live.report.cases,
        passed: live.report.passed,
        passRate: live.report.passRate,
        minPassRate,
        failed: live.report.results
          .filter((r) => !r.passed)
          .map((r) => ({
            id: r.id,
            missingContains: r.missingContains,
            forbiddenHits: r.forbiddenHits,
            missingTables: r.missingTables,
            error: r.error,
            sqlPreview: r.sql.slice(0, 160),
          })),
      },
      null,
      2,
    ),
  );

  if (!live.ok) {
    console.error("[verify:llm-eval] 真实 Text-to-SQL 准确率未达标");
    process.exit(1);
  }
  console.info("[verify:llm-eval] live Text-to-SQL accuracy 通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
