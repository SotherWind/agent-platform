import assert from "node:assert/strict";
import { appendFreshnessWarnings } from "../../src/runtime/freshness-answer.js";
import { computeMetadataFreshness } from "../../src/metadata/freshness.js";
import { test, section } from "../helpers/runner.js";

export async function testFreshnessInAnswer() {
  section("Freshness 写入答案");

  await test("stale 状态在答案中追加告警", () => {
    const freshness = computeMetadataFreshness(
      [
        {
          id: "t1",
          docType: "table",
          datasourceId: "ecommerce_sqlite",
          domain: "retail",
          dialectFamily: "sqlite",
          content: "orders",
          sourceUpdatedAt: "2020-01-01T00:00:00.000Z",
          reviewStatus: "approved",
        },
      ],
      { now: new Date("2026-07-15T00:00:00.000Z") },
    );
    assert.equal(freshness.status, "stale");
    const answer = appendFreshnessWarnings("分析结果正常。", freshness);
    assert.match(answer, /stale|新鲜度/i);
    assert.match(answer, /注意/);
  });
}
