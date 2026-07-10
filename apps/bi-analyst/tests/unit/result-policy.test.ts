import assert from "node:assert/strict";
import { applyResultPolicy } from "../../src/policy/result-policy.js";
import { test, section } from "../helpers/runner.js";

export async function testResultPolicy() {
  section("结果防泄漏 (ResultPolicy)");

  await test("deny 策略移除禁止列", () => {
    const result = applyResultPolicy(
      {
        rows: [{ city: "北京", phone: "13800000000" }],
        columns: ["city", "phone"],
        isEmpty: false,
      },
      {
        options: {
          maskColumns: [{ column: "phone", strategy: "deny" }],
        },
      },
    );
    assert.deepEqual(result.columns, ["city"]);
    assert.equal(result.rows[0].phone, undefined);
  });

  await test("行数超限截断", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const result = applyResultPolicy(
      { rows, columns: ["id"], isEmpty: false },
      { options: { maxRows: 5 } },
    );
    assert.equal(result.rows.length, 5);
    assert.ok(result.warnings?.some((w) => /截断/.test(w)));
  });

  await test("错误结果原样返回", () => {
    const input = {
      rows: [],
      columns: [],
      isEmpty: true,
      error: "查询失败",
    };
    assert.deepEqual(applyResultPolicy(input), input);
  });
}
