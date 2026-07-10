import assert from "node:assert/strict";
import { shouldRetry } from "../../src/agent";
import { test, section } from "../helpers/runner";

export async function testShouldRetry() {
  section("Agent 路由 (shouldRetry)");

  const originalMaxRetry = process.env.MAX_RETRY_COUNT;
  process.env.MAX_RETRY_COUNT = "3";

  try {
    await test("无错误 → chartFormatter", () => {
      assert.equal(
        shouldRetry({ retryCount: 0, executionResult: { rows: [], columns: [], isEmpty: false } } as never),
        "chartFormatter",
      );
    });

    await test("有错误且未超重试上限 → retry", () => {
      assert.equal(
        shouldRetry({
          retryCount: 0,
          executionResult: { rows: [], columns: [], isEmpty: true, error: "syntax error" },
        } as never),
        "retry",
      );
      assert.equal(
        shouldRetry({
          retryCount: 2,
          executionResult: { rows: [], columns: [], isEmpty: true, error: "syntax error" },
        } as never),
        "retry",
      );
    });

    await test("有错误且达到重试上限 → chartFormatter", () => {
      assert.equal(
        shouldRetry({
          retryCount: 3,
          executionResult: { rows: [], columns: [], isEmpty: true, error: "syntax error" },
        } as never),
        "chartFormatter",
      );
    });

    await test("policy_rejected 不可重试 → chartFormatter", () => {
      assert.equal(
        shouldRetry({
          retryCount: 0,
          executionResult: {
            rows: [],
            columns: [],
            isEmpty: true,
            error: "查询违反安全策略",
            failureKind: "policy_rejected",
          },
        } as never),
        "chartFormatter",
      );
    });

    await test("MAX_RETRY_COUNT 环境变量生效", () => {
      process.env.MAX_RETRY_COUNT = "1";
      assert.equal(
        shouldRetry({
          retryCount: 1,
          executionResult: { rows: [], columns: [], isEmpty: true, error: "err" },
        } as never),
        "chartFormatter",
      );
    });
  } finally {
    if (originalMaxRetry === undefined) {
      delete process.env.MAX_RETRY_COUNT;
    } else {
      process.env.MAX_RETRY_COUNT = originalMaxRetry;
    }
  }
}
