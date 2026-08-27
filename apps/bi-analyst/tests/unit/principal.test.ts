import assert from "node:assert/strict";
import {
  parseAnalyzeRequest,
  assertSessionOwnership,
  buildSessionKey,
  AuthError,
} from "../../src/auth/principal.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { AppError } from "../../src/errors/app-error.js";
import { test, section } from "../helpers/runner.js";

export async function testPrincipal() {
  section("可信身份与会话 (principal)");

  await test("parseAnalyzeRequest 只接受 query + sessionId", () => {
    const req = parseAnalyzeRequest({
      query: "北京用户订单总额",
      sessionId: "sess-1",
    });
    assert.equal(req.query, "北京用户订单总额");
    assert.equal(req.sessionId, "sess-1");
  });

  await test("parseAnalyzeRequest 接受 clarificationChoice", () => {
    const req = parseAnalyzeRequest({
      query: "继续",
      clarificationChoice: "datasource.ecommerce_sqlite",
    });
    assert.equal(req.clarificationChoice, "datasource.ecommerce_sqlite");
  });

  await test("空 query 属于请求校验错误而非认证错误", () => {
    assert.throws(
      () => parseAnalyzeRequest({ query: "   " }),
      (err: AppError) =>
        err.code === "validation_error" && err.statusCode === 400,
    );
  });

  await test("拒绝请求体伪造 userId / tenantId", () => {
    assert.throws(
      () =>
        parseAnalyzeRequest({
          query: "test",
          userId: "attacker",
        }),
      (err: AuthError) => err.code === "forged_identity",
    );
  });

  await test("会话所有权校验", () => {
    const principal = createTestPrincipal();
    assert.doesNotThrow(() =>
      assertSessionOwnership(principal, {
        sessionId: "s1",
        tenantId: "tenant-1",
        subjectId: "user-test",
        policyVersion: "1",
        createdAt: "",
        updatedAt: "",
      }),
    );
  });

  await test("跨用户 session 被拒绝", () => {
    const principal = createTestPrincipal();
    assert.throws(
      () =>
        assertSessionOwnership(principal, {
          sessionId: "s1",
          tenantId: "tenant-1",
          subjectId: "other-user",
          policyVersion: "1",
          createdAt: "",
          updatedAt: "",
        }),
      (err: AuthError) => err.code === "session_forbidden",
    );
  });

  await test("checkpointer 复合键", () => {
    assert.equal(
      buildSessionKey("tenant-1", "user-1", "sess-abc"),
      "tenant-1:user-1:sess-abc",
    );
  });
}
