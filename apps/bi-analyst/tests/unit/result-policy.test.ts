import assert from "node:assert/strict";
import {
  applyResultPolicy,
  maskValue,
  inferMaskValueType,
  extractAggregationCountColumns,
} from "../../src/policy/result-policy.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { createTestPrincipal } from "../helpers/principal.js";
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
    assert.equal(result.degraded, true);
    assert.ok(result.degradationReasons?.includes("maxRows"));
  });

  await test("响应体超限返回结构化降级状态", () => {
    const result = applyResultPolicy(
      {
        rows: Array.from({ length: 20 }, (_, i) => ({ value: "x".repeat(40), i })),
        columns: ["i", "value"],
        isEmpty: false,
      },
      { options: { maxResponseBytes: 180 } },
    );
    assert.equal(result.degraded, true);
    assert.ok(result.degradationReasons?.includes("maxResponseBytes"));
    assert.ok(result.warnings?.some((w) => /响应体|response/i.test(w)));
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

  await test("聚合空集的 null 哨兵行归一为空结果", () => {
    const result = applyResultPolicy({
      rows: [{ amount: null }],
      columns: ["amount"],
      isEmpty: false,
      stats: { durationMs: 1, rowCount: 1 },
    });
    assert.equal(result.isEmpty, true);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.columns, []);
    assert.equal(result.stats?.rowCount, 0);
  });

  await test("inferMaskValueType 识别 email/phone/number", () => {
    assert.equal(inferMaskValueType("a@b.com"), "email");
    assert.equal(inferMaskValueType("13800138000", "phone"), "phone");
    assert.equal(inferMaskValueType(42), "number");
    assert.equal(inferMaskValueType(true), "boolean");
  });

  await test("partial 对 phone 保留头尾", () => {
    const masked = maskValue("13800138000", "partial", {
      column: "phone",
    });
    assert.equal(masked, "138****8000");
  });

  await test("partial 对 email 保留域名", () => {
    const masked = maskValue("alice@example.com", "partial", {
      valueType: "email",
    });
    assert.equal(masked, "a***@example.com");
  });

  await test("partial 对 number 隐藏精确值", () => {
    const masked = maskValue(13800000000, "partial");
    assert.equal(typeof masked, "string");
    assert.match(String(masked), /^1\*+$/);
  });

  await test("hash 对 boolean/object 使用类型前缀", () => {
    assert.equal(maskValue(true, "hash"), "***bool");
    assert.match(String(maskValue({ a: 1 }, "hash")), /^\*\*\*obj/);
  });

  await test("accessPolicy.maskRules 合并 partial", () => {
    const policy = createDefaultAccessPolicy(createTestPrincipal());
    policy.maskRules = [
      { table: "users", column: "name", strategy: "partial" },
    ];
    const result = applyResultPolicy(
      {
        rows: [{ name: "张三丰", city: "北京" }],
        columns: ["name", "city"],
        isEmpty: false,
      },
      { accessPolicy: policy },
    );
    assert.equal(result.rows[0]!.city, "北京");
    assert.notEqual(result.rows[0]!.name, "张三丰");
    assert.match(String(result.rows[0]!.name), /\*\*\*/);
  });

  await test("null 掩码保持 null", () => {
    assert.equal(maskValue(null, "hash"), null);
    assert.equal(maskValue(undefined, "partial"), undefined);
  });

  await test("minAggregationCount �����������С������", () => {
    const result = applyResultPolicy(
      {
        rows: [
          { city: "A", n: 1 },
          { city: "B", n: 3 },
        ],
        columns: ["city", "n"],
        isEmpty: false,
      },
      {
        options: {
          minAggregationCount: 2,
          aggregationCountColumns: ["n"],
          enforceAggregationCount: true,
        },
      },
    );
    assert.deepEqual(result.rows, [{ city: "B", n: 3 }]);
    assert.equal(result.degraded, true);
    assert.ok(result.degradationReasons?.includes("minAggregationCount"));
  });

  await test("minAggregationCount �޼�������ʱ�ܾ�����", () => {
    const result = applyResultPolicy(
      {
        rows: [{ city: "A", revenue: 10 }],
        columns: ["city", "revenue"],
        isEmpty: false,
      },
      {
        options: {
          minAggregationCount: 2,
          enforceAggregationCount: true,
        },
      },
    );
    assert.deepEqual(result.rows, []);
    assert.equal(result.isEmpty, true);
    assert.ok(result.degradationReasons?.includes("minAggregationCount"));
  });

  await test("extractAggregationCountColumns ֻ����ʶ����ȷ COUNT ����", () => {
    assert.deepEqual(
      extractAggregationCountColumns(
        "SELECT city, COUNT(*) AS n, SUM(revenue) AS total FROM orders GROUP BY city",
      ),
      ["n"],
    );
  });
}
