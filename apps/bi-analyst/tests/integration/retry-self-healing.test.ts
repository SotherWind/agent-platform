import assert from "node:assert/strict";
import { buildGraph } from "../../src/agent";
import { generateSqlTool } from "../../src/tools/generate_sql";
import { test, section, addSkipped } from "../helpers/runner";
import { createTestDb, cleanupDb } from "../helpers/db";
import { hasLlmConfig, MULTI_BAD_SQL } from "../helpers/fixtures";
import { extractFixError, logRetryTrail } from "../helpers/retry-sim";
import { invokeGraphWithRetry, patchSqlSequence, sleep } from "../helpers/graph";
import { getTestRuntimeProfile } from "../helpers/profile";

export const INTEGRATION_RETRY_CASE_COUNT = 4;

export async function testIntegrationRetrySelfHealing(runIntegration: boolean) {
  section("端到端 SQL 重试自愈 (buildGraph + patch)");

  const INTEGRATION_TIMEOUT_MS = Number(process.env.INTEGRATION_TIMEOUT_MS ?? 300_000);

  if (!runIntegration) {
    console.log("  ⊘ 跳过：使用 npm run test:integration");
    addSkipped(INTEGRATION_RETRY_CASE_COUNT);
    return;
  }

  if (!hasLlmConfig()) {
    console.log("  ⊘ 跳过：未配置 MODEL_API_KEY");
    addSkipped(INTEGRATION_RETRY_CASE_COUNT);
    return;
  }

  const { db, dbPath } = createTestDb();
  const buildGraphWithRetry = (maxRetryCount: number) =>
    buildGraph({
      db,
      runtimeProfile: getTestRuntimeProfile(),
      maxRetryCount,
    });
  const originalInvoke = generateSqlTool.invoke.bind(generateSqlTool);
  const originalMaxRetry = process.env.MAX_RETRY_COUNT;

  try {
    await test("三次重试后自愈：连续 3 种不同错误 → 第 4 次 LLM 修复", async () => {
      process.env.MAX_RETRY_COUNT = "3";
      const graph = buildGraphWithRetry(3);
      const tracker = patchSqlSequence(originalInvoke, [...MULTI_BAD_SQL], "llm");

      const result = await invokeGraphWithRetry(
        graph,
        "统计各城市的用户数量",
        "三次重试自愈",
        INTEGRATION_TIMEOUT_MS,
      );

      assert.equal(tracker.sqlGenCalls, 4, "应经历 4 次 SQL 生成");
      assert.equal(result.retryCount, 3, "应重试 3 次");
      assert.equal(tracker.capturedQueries[0], "统计各城市的用户数量");
      for (let i = 1; i <= 3; i++) {
        assert.match(tracker.capturedQueries[i], /fix error:/i, `第 ${i + 1} 次应携带 fix error`);
        const err = extractFixError(tracker.capturedQueries[i]);
        assert.ok(err, `第 ${i + 1} 次应解析出错误信息`);
      }
      assert.equal(result.executionResult?.error, undefined);
      assert.equal(result.executionResult?.isEmpty, false);
      assert.ok(result.chartSpec);
      assert.match(result.generatedSql!, /SELECT/i);

      console.log(`      SQL 调用: ${tracker.sqlGenCalls} 次 | retryCount: ${result.retryCount}`);
      logRetryTrail(tracker.capturedQueries, tracker.failedSqls);
      console.log(`      最终 SQL: ${result.generatedSql?.slice(0, 80)}...`);
    });

    if (Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000) > 0) {
      await sleep(Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000));
    }

    await test("三次重试耗尽：4 次坏 SQL 全部失败 → Execution error", async () => {
      process.env.MAX_RETRY_COUNT = "3";
      const graph = buildGraphWithRetry(3);
      const tracker = patchSqlSequence(originalInvoke, [...MULTI_BAD_SQL, "DROP TABLE users"], "always-bad");

      const result = await invokeGraphWithRetry(
        graph,
        "查询各城市订单总额",
        "三次重试耗尽",
        INTEGRATION_TIMEOUT_MS,
      );

      assert.equal(tracker.sqlGenCalls, 4, "MAX_RETRY=3 时最多生成 4 次 SQL");
      assert.equal(result.retryCount, 3);
      assert.ok(result.executionResult?.error);
      assert.match(result.finalAnswer!, /^Execution error:/);

      console.log(`      SQL 调用: ${tracker.sqlGenCalls} 次 | retryCount: ${result.retryCount}`);
      logRetryTrail(tracker.capturedQueries, tracker.failedSqls);
      console.log(`      最终错误: ${result.executionResult?.error}`);
      console.log(`      Answer: ${result.finalAnswer}`);
    });

    if (Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000) > 0) {
      await sleep(Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000));
    }

    await test("坏 SQL 自愈：第 1 次失败 → 重试 → LLM 修复 → 成功", async () => {
      process.env.MAX_RETRY_COUNT = "3";
      const graph = buildGraphWithRetry(3);
      const capturedQueries: string[] = [];
      let sqlGenCalls = 0;

      generateSqlTool.invoke = (async (input) => {
        sqlGenCalls++;
        const payload = input as { query: string };
        capturedQueries.push(payload.query);
        if (sqlGenCalls === 1) return "SELECT FROM users";
        return originalInvoke(input);
      }) as typeof generateSqlTool.invoke;

      const result = await invokeGraphWithRetry(
        graph,
        "统计各城市的用户数量",
        "SQL重试自愈",
        INTEGRATION_TIMEOUT_MS,
      );

      assert.equal(sqlGenCalls, 2, "应调用 generateSql 两次");
      assert.ok((result.retryCount ?? 0) >= 1, `retryCount 应 >= 1，实际 ${result.retryCount}`);
      assert.equal(capturedQueries[0], "统计各城市的用户数量");
      assert.match(capturedQueries[1], /fix error:/i);
      const triggerError = extractFixError(capturedQueries[1]);
      assert.ok(triggerError, "应能从重试 query 中解析出触发错误");
      assert.equal(result.executionResult?.error, undefined);
      assert.equal(result.executionResult?.isEmpty, false);
      assert.ok(result.chartSpec);
      assert.ok(result.finalAnswer);
      assert.match(result.generatedSql!, /SELECT/i);

      console.log(`      SQL 调用: ${sqlGenCalls} 次 | retryCount: ${result.retryCount}`);
      console.log(`      触发错误: ${triggerError}`);
      console.log(`      失败 SQL: SELECT FROM users`);
      console.log(`      最终 SQL: ${result.generatedSql?.slice(0, 70)}...`);
    });

    if (Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000) > 0) {
      await sleep(Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000));
    }

    await test("重试耗尽：持续坏 SQL → Execution error", async () => {
      process.env.MAX_RETRY_COUNT = "1";
      const graph = buildGraphWithRetry(1);
      const tracker = patchSqlSequence(originalInvoke, ["SELECT FROM users"], "always-bad");

      const result = await invokeGraphWithRetry(
        graph,
        "查询所有用户",
        "SQL重试耗尽",
        INTEGRATION_TIMEOUT_MS,
      );

      assert.equal(tracker.sqlGenCalls, 2, "MAX_RETRY=1 时应生成 2 次 SQL");
      assert.ok((result.retryCount ?? 0) >= 1);
      assert.ok(result.executionResult?.error);
      assert.match(result.finalAnswer!, /^Execution error:/);
      assert.match(tracker.capturedQueries[1], /fix error:/i);
      const triggerError = extractFixError(tracker.capturedQueries[1]);
      assert.ok(triggerError);

      console.log(`      SQL 调用: ${tracker.sqlGenCalls} 次 | retryCount: ${result.retryCount}`);
      logRetryTrail(tracker.capturedQueries, tracker.failedSqls);
      console.log(`      最终错误: ${result.executionResult?.error}`);
      console.log(`      Answer: ${result.finalAnswer?.slice(0, 70)}...`);
    });
  } finally {
    generateSqlTool.invoke = originalInvoke;
    if (originalMaxRetry === undefined) {
      delete process.env.MAX_RETRY_COUNT;
    } else {
      process.env.MAX_RETRY_COUNT = originalMaxRetry;
    }
    db.close();
    cleanupDb(dbPath);
  }
}
