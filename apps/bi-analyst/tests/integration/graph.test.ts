import assert from "node:assert/strict";
import { buildGraph } from "../../src/agent";
import { generateSqlTool } from "../../src/tools/generate_sql";
import { test, section, addSkipped } from "../helpers/runner";
import { createTestDb, cleanupDb } from "../helpers/db";
import { deterministicIntegrationSql, hasLlmConfig } from "../helpers/fixtures";
import { invokeGraphWithRetry, sleep } from "../helpers/graph";
import { getTestRuntimeProfile } from "../helpers/profile";

export const INTEGRATION_CASE_COUNT = 5;

interface IntegrationCase {
  name: string;
  query: string;
  validate: (result: Awaited<ReturnType<ReturnType<typeof buildGraph>["invoke"]>>) => void;
}

const INTEGRATION_CASES: IntegrationCase[] = [
  {
    name: "分组聚合：北京用户订单总额",
    query: "查一下北京用户的订单总额，按用户分组",
    validate(result) {
      assert.ok(result.generatedSql, "应生成 SQL");
      assert.match(result.generatedSql!, /SELECT/i);
      assert.ok(result.finalAnswer, "应有最终回答");
      if (result.executionResult?.error) {
        assert.match(result.finalAnswer!, /error|失败|Execution error/i);
      } else {
        assert.equal(result.executionResult?.isEmpty, false);
        assert.ok(result.chartSpec, "成功路径应生成图表");
        assert.ok(["bar", "line", "pie", "table", "scatter"].includes(result.chartSpec!.type));
      }
    },
  },
  {
    name: "城市维度汇总",
    query: "统计每个城市的用户数量和订单总金额",
    validate(result) {
      assert.ok(result.generatedSql);
      assert.ok(result.finalAnswer);
      if (!result.executionResult?.error) {
        assert.ok(result.executionResult!.rows.length >= 1);
      }
    },
  },
  {
    name: "时间趋势分析",
    query: "按月份统计订单数量，展示趋势",
    validate(result) {
      assert.ok(result.generatedSql);
      assert.ok(result.finalAnswer);
      if (!result.executionResult?.error) {
        assert.ok(result.chartSpec);
        assert.equal(result.chartSpec!.type, "line");
        assert.ok(result.executionResult!.rows.length >= 2);
        assert.match(result.generatedSql!, /GROUP BY/i);
      }
    },
  },
  {
    name: "空结果查询",
    query: "查询城市为「火星」的所有用户订单",
    validate(result) {
      assert.ok(result.generatedSql);
      assert.ok(result.finalAnswer);
      if (!result.executionResult?.error) {
        const empty =
          result.executionResult?.isEmpty ||
          result.finalAnswer?.includes("no data") ||
          result.finalAnswer?.includes("没有") ||
          result.finalAnswer?.includes("无数据");
        assert.ok(empty || result.chartSpec?.type === "table");
      }
    },
  },
  {
    name: "占比分析",
    query: "各订单状态的订单数量占比是多少",
    validate(result) {
      assert.ok(result.generatedSql);
      assert.ok(result.finalAnswer);
      if (!result.executionResult?.error && result.chartSpec) {
        assert.ok(["pie", "bar", "table"].includes(result.chartSpec.type));
      }
    },
  },
];

export async function testIntegration(runIntegration: boolean) {
  section("端到端集成 (buildGraph + deterministic/live adapter)");

  if (!runIntegration) {
    console.log("  ⊘ 跳过：使用 npm run test:integration 或设置 RUN_INTEGRATION_TESTS=1");
    addSkipped(INTEGRATION_CASE_COUNT);
    return;
  }

  const useLiveLlm = process.env.ENABLE_LIVE_LLM_EVAL === "1";
  if (useLiveLlm && !hasLlmConfig()) {
    console.log("  ⊘ 跳过：已请求 live LLM，但未配置 MODEL_API_KEY");
    addSkipped(INTEGRATION_CASE_COUNT);
    return;
  }

  const { db, dbPath } = createTestDb();
  const graph = buildGraph({ db, runtimeProfile: getTestRuntimeProfile() });
  const INTEGRATION_TIMEOUT_MS = Number(process.env.INTEGRATION_TIMEOUT_MS ?? 300_000);
  const caseDelayMs = Number(process.env.INTEGRATION_CASE_DELAY_MS ?? 2000);
  const originalMaxRetry = process.env.MAX_RETRY_COUNT;
  const originalInvoke = generateSqlTool.invoke.bind(generateSqlTool);
  process.env.MAX_RETRY_COUNT = "1";
  if (!useLiveLlm) {
    generateSqlTool.invoke = (async (input) =>
      deterministicIntegrationSql(
        String((input as { query?: unknown }).query ?? ""),
      )) as typeof generateSqlTool.invoke;
  }

  try {
    for (let i = 0; i < INTEGRATION_CASES.length; i++) {
      const { name, query, validate } = INTEGRATION_CASES[i];
      if (i > 0 && caseDelayMs > 0) await sleep(caseDelayMs);

      await test(name, async () => {
        console.log(`      查询: ${query}`);
        const result = await invokeGraphWithRetry(graph, query, name, INTEGRATION_TIMEOUT_MS);
        validate(result);
        console.log(`      SQL: ${result.generatedSql?.slice(0, 80)}...`);
        console.log(`      重试: ${result.retryCount ?? 0} | Chart: ${result.chartSpec?.type ?? "none"}`);
        if (result.executionResult?.error) {
          console.log(`      执行错误: ${result.executionResult.error}`);
        }
        console.log(`      Answer: ${result.finalAnswer?.slice(0, 60)}...`);
      });
    }
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
