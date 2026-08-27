import assert from "node:assert/strict";
import {
  parseClarificationChoice,
} from "../../src/query-plan/clarification-resolver.js";
import { AuthError, parseAnalyzeRequest } from "../../src/auth/principal.js";
import { test, section } from "../helpers/runner.js";

export async function testClarificationResolver() {
  section("澄清选项解析 (clarification-resolver)");

  await test("解析 datasource / metric / range 选项", () => {
    assert.deepEqual(parseClarificationChoice("datasource.ecommerce_sqlite"), {
      kind: "datasource",
      id: "datasource.ecommerce_sqlite",
      value: "ecommerce_sqlite",
    });
    assert.deepEqual(parseClarificationChoice("metric.order_count"), {
      kind: "metric",
      id: "metric.order_count",
      value: "order_count",
    });
    assert.deepEqual(parseClarificationChoice("range.last_7d"), {
      kind: "range",
      id: "range.last_7d",
      value: "last_7d",
    });
  });

  await test("空值返回 undefined", () => {
    assert.equal(parseClarificationChoice(undefined), undefined);
    assert.equal(parseClarificationChoice(""), undefined);
  });

  await test("非法格式 fail closed", () => {
    assert.throws(
      () => parseClarificationChoice("invalid-choice"),
      (err: AuthError) => err.code === "unauthenticated",
    );
    assert.throws(
      () => parseClarificationChoice("table.users"),
      (err: AuthError) => err.code === "unauthenticated",
    );
  });

  await test("parseAnalyzeRequest 接受 clarificationChoice", () => {
    const req = parseAnalyzeRequest({
      query: "继续",
      sessionId: "sess-1",
      clarificationChoice: "range.last_30d",
    });
    assert.equal(req.clarificationChoice, "range.last_30d");
    assert.equal(req.sessionId, "sess-1");
  });
}
