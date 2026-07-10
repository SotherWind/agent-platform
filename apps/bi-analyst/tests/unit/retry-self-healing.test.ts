import assert from "node:assert/strict";
import { shouldRetry } from "../../src/agent";
import { createExecuteCodeTool } from "../../src/tools/execute_code";
import type { ExecutionResult } from "../../src/entities";
import { test, section } from "../helpers/runner";
import { createTestDb, cleanupDb, EXEC_CTX } from "../helpers/db";
import { MULTI_BAD_SQL } from "../helpers/fixtures";
import {
  applyRetryIncrement,
  buildSqlGenQuery,
  extractFixError,
  logRetryTrail,
  simulateChartFormatter,
} from "../helpers/retry-sim";

export async function testRetrySelfHealingFlow() {
  section("SQL 错误重试自愈 (逻辑层模拟)");

  const originalMaxRetry = process.env.MAX_RETRY_COUNT;

  await test("SQL 生成：首次无 error 上下文，重试后附带 fix error", () => {
    const q = "统计北京用户订单";
    assert.equal(buildSqlGenQuery(q, null), q);
    assert.equal(
      buildSqlGenQuery(q, { error: "no such column: citys" }),
      "统计北京用户订单 (fix error: no such column: citys)",
    );
  });

  await test("retryNode：retryCount 每次累加 1", () => {
    assert.equal(applyRetryIncrement(0), 1);
    assert.equal(applyRetryIncrement(2), 3);
  });

  const { db, dbPath } = createTestDb();
  const executeCode = createExecuteCodeTool(db);

  try {
    await test("自愈成功：坏 SQL → 重试 → 好 SQL → 拿到数据", async () => {
      process.env.MAX_RETRY_COUNT = "3";
      const executeSql = async (sql: string) =>
        executeCode.invoke({ sql, executionContext: EXEC_CTX, expectedFormat: "chart-ready" }) as Promise<ExecutionResult>;

      let retryCount = 0;
      let executionResult: ExecutionResult | null = null;
      const capturedQueries: string[] = [];
      const sqlSequence = ["SELECT FROM users", "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city"];
      let sqlIndex = 0;

      while (sqlIndex < sqlSequence.length + 1) {
        const query = buildSqlGenQuery("统计各城市用户数", executionResult);
        capturedQueries.push(query);
        const sql = sqlSequence[sqlIndex++];
        executionResult = await executeSql(sql);

        const route = shouldRetry({ retryCount, executionResult } as never);
        if (route === "chartFormatter") break;
        retryCount = applyRetryIncrement(retryCount);
      }

      assert.equal(capturedQueries.length, 2);
      assert.equal(capturedQueries[0], "统计各城市用户数");
      assert.match(capturedQueries[1], /fix error:/);
      assert.equal(retryCount, 1);
      const triggerError = extractFixError(capturedQueries[1]);
      console.log(`      触发错误: ${triggerError}`);
      assert.equal(executionResult!.isEmpty, false);
      assert.ok(executionResult!.rows.length > 0);
      assert.equal(executionResult!.error, undefined);
    });

    await test("重试耗尽：持续坏 SQL → 最终返回 Execution error", async () => {
      process.env.MAX_RETRY_COUNT = "1";
      const executeSql = async (sql: string) =>
        executeCode.invoke({ sql, executionContext: EXEC_CTX, expectedFormat: "chart-ready" }) as Promise<ExecutionResult>;

      const { retryCount, executionResult, capturedQueries } = await (async () => {
        let retryCount = 0;
        let executionResult: ExecutionResult | null = null;
        const capturedQueries: string[] = [];
        let steps = 0;

        while (steps++ < 5) {
          const query = buildSqlGenQuery("查询用户", executionResult);
          capturedQueries.push(query);
          executionResult = await executeSql("SELECT FROM users");

          const route = shouldRetry({ retryCount, executionResult } as never);
          if (route === "chartFormatter") break;
          retryCount = applyRetryIncrement(retryCount);
        }
        return { retryCount, executionResult: executionResult!, capturedQueries };
      })();

      assert.equal(retryCount, 1);
      assert.equal(capturedQueries.length, 2);
      assert.ok(executionResult.error);
      const triggerError = extractFixError(capturedQueries[1]);
      console.log(`      触发错误: ${triggerError}`);
      const formatted = simulateChartFormatter("查询用户", executionResult);
      assert.match(formatted.finalAnswer!, /^Execution error:/);
    });

    await test("完整链路模拟：错误 → 重试 → 成功 → 图表输出", async () => {
      process.env.MAX_RETRY_COUNT = "3";
      const executeSql = async (sql: string) =>
        executeCode.invoke({ sql, executionContext: EXEC_CTX, expectedFormat: "chart-ready" }) as Promise<ExecutionResult>;

      const { retryCount, executionResult } = await (async () => {
        let retryCount = 0;
        let executionResult: ExecutionResult | null = null;
        const sqlSequence = ["SELECT FROM users", "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city"];
        let sqlIndex = 0;

        while (sqlIndex < sqlSequence.length) {
          executionResult = await executeSql(sqlSequence[sqlIndex++]);
          const route = shouldRetry({ retryCount, executionResult } as never);
          if (route === "chartFormatter") break;
          retryCount = applyRetryIncrement(retryCount);
        }
        return { retryCount, executionResult: executionResult! };
      })();

      assert.equal(retryCount, 1);
      assert.equal(executionResult.isEmpty, false);

      const chart = simulateChartFormatter("统计各城市用户数", executionResult, () => ({
        chartType: "bar" as const,
        title: "各城市用户数",
        explanation: "分类对比用柱状图",
      }));
      assert.equal(chart.chartSpec?.type, "bar");
      assert.equal(chart.finalAnswer, "分类对比用柱状图");
    });

    await test("三次重试后自愈：三种不同错误逐步修复", async () => {
      process.env.MAX_RETRY_COUNT = "3";
      const badSqlSequence = [...MULTI_BAD_SQL];
      const executeSql = async (sql: string) =>
        executeCode.invoke({ sql, executionContext: EXEC_CTX, expectedFormat: "chart-ready" }) as Promise<ExecutionResult>;

      let retryCount = 0;
      let executionResult: ExecutionResult | null = null;
      const capturedQueries: string[] = [];
      const failedSqls: string[] = [];
      let sqlIndex = 0;

      while (sqlIndex < badSqlSequence.length + 1) {
        const query = buildSqlGenQuery("统计各城市用户数", executionResult);
        capturedQueries.push(query);
        const sql = sqlIndex < badSqlSequence.length
          ? badSqlSequence[sqlIndex++]
          : "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city";
        failedSqls.push(sql);
        executionResult = await executeSql(sql);

        const route = shouldRetry({ retryCount, executionResult } as never);
        if (route === "chartFormatter") break;
        retryCount = applyRetryIncrement(retryCount);
      }

      assert.equal(retryCount, 3);
      assert.equal(capturedQueries.length, 4);
      assert.equal(executionResult!.isEmpty, false);
      assert.match(extractFixError(capturedQueries[1])!, /语法错误/);
      assert.match(extractFixError(capturedQueries[2])!, /未知.*表|不存在/);
      assert.match(extractFixError(capturedQueries[3])!, /未知.*字段|不存在/);
      logRetryTrail(capturedQueries, failedSqls);
    });

    await test("chartFormatter 降级：图表推荐失败 → 回退 table", () => {
      const result = simulateChartFormatter(
        "查询",
        { columns: ["city", "cnt"], rows: [{ city: "北京", cnt: 4 }], isEmpty: false },
        () => { throw new Error("LLM unavailable"); },
      );
      assert.match(result.finalAnswer!, /Formatting failed.*Degrading to table/);
      assert.equal(result.chartSpec?.title, "Raw Data Fallback");
    });

    await test("chartFormatter 空结果：isEmpty → 空 table", () => {
      const result = simulateChartFormatter("查询火星用户", {
        columns: [],
        rows: [],
        isEmpty: true,
      });
      assert.equal(result.finalAnswer, "Query returned no data.");
      assert.equal(result.chartSpec?.title, "Empty Result");
    });
  } finally {
    db.close();
    cleanupDb(dbPath);
    if (originalMaxRetry === undefined) {
      delete process.env.MAX_RETRY_COUNT;
    } else {
      process.env.MAX_RETRY_COUNT = originalMaxRetry;
    }
  }
}
