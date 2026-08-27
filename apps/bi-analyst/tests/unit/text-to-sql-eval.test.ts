import assert from "node:assert/strict";
import {
  normalizeSql,
  scoreGeneratedSql,
  evaluateTextToSqlCases,
} from "../../src/evaluation/sql-accuracy.js";
import {
  loadTextToSqlGoldenCases,
  mockDeterministicSqlGenerator,
  runTextToSqlAccuracyEval,
} from "../../src/evaluation/text-to-sql-eval.js";
import { test, section } from "../helpers/runner.js";

export async function testTextToSqlEval() {
  section("Text-to-SQL Accuracy Eval (Phase E)");

  await test("normalizeSql 去注释与折叠空白", () => {
    const n = normalizeSql(
      "SELECT  a  -- comment\nFROM orders /* x */ WHERE 1=1",
    );
    assert.equal(n, "select a from orders where 1=1");
  });

  await test("scoreGeneratedSql 校验 mustContain / 禁止写入", () => {
    const ok = scoreGeneratedSql(
      "SELECT SUM(amount) FROM orders JOIN users ON orders.user_id = users.id WHERE city = '北京'",
      {
        id: "t1",
        description: "x",
        query: "x",
        mustContain: ["sum", "join", "北京"],
        requiredTables: ["orders", "users"],
        mustNotContain: ["insert ", "drop "],
      },
    );
    assert.equal(ok.passed, true);

    const bad = scoreGeneratedSql("INSERT INTO orders VALUES (1)", {
      id: "t2",
      description: "x",
      query: "x",
      mustContain: ["select"],
      mustNotContain: ["insert "],
    });
    assert.equal(bad.passed, false);
    assert.ok(bad.forbiddenHits.includes("insert "));
  });

  await test("mock 生成器通过 golden 全量套件", async () => {
    const cases = loadTextToSqlGoldenCases();
    assert.ok(cases.length >= 20);
    const report = await evaluateTextToSqlCases(
      cases,
      mockDeterministicSqlGenerator,
    );
    assert.equal(report.passRate, 1);
    assert.equal(report.passed, report.cases);
  });

  await test("runTextToSqlAccuracyEval 离线门禁", async () => {
    const { ok, report } = await runTextToSqlAccuracyEval();
    assert.equal(ok, true);
    assert.ok(report.cases >= 20);
  });
}
