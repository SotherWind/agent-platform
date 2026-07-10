import assert from "node:assert/strict";
import {
  classifySqlError,
  sanitizeSqlError,
  isRetriableFailure,
  formatErrorForLlm,
} from "../../src/errors/sql-failure.js";
import { test, section } from "../helpers/runner.js";

export async function testSqlFailure() {
  section("SQL 错误分类与脱敏");

  await test("syntax_error 可重试", () => {
    const kind = classifySqlError("near \"SELEC\": syntax error");
    assert.equal(kind, "syntax_error");
    assert.equal(isRetriableFailure(kind), true);
  });

  await test("unknown_column 可重试", () => {
    assert.equal(
      classifySqlError("no such column: citys"),
      "unknown_column",
    );
  });

  await test("permission_denied 不可重试", () => {
    assert.equal(isRetriableFailure("permission_denied"), false);
  });

  await test("timeout 不可重试", () => {
    assert.equal(isRetriableFailure("timeout"), false);
  });

  await test("脱敏后不暴露原始数据库错误", () => {
    const s = sanitizeSqlError('SQLITE_ERROR: no such table: users_secret');
    assert.equal(s.safeMessage, "引用了未知或不存在的表");
    assert.notEqual(s.safeMessage, s.rawMessage);
  });

  await test("LLM 重试 prompt 使用 kind + safeMessage", () => {
    const s = sanitizeSqlError("syntax error near SELEC");
    const formatted = formatErrorForLlm(s);
    assert.match(formatted, /^syntax_error:/);
    assert.doesNotMatch(formatted, /SELEC/);
  });
}
