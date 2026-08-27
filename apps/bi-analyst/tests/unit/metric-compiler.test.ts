import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MetricRegistry,
  compileCertifiedMetric,
} from "../../src/semantic/index.js";
import { inferEntityName, inferTimeGrain } from "../../src/agent.js";
import { test, section } from "../helpers/runner.js";

export async function testMetricCompiler() {
  section("MetricRegistry + certified 编译");

  const metricsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../metadata/metrics",
  );
  const registry = MetricRegistry.fromDirectory(metricsDir);

  await test("加载 certified 指标", () => {
    const list = registry.listCertified();
    assert.ok(list.length >= 5);
    assert.ok(registry.get("order_total_amount"));
    assert.ok(registry.get("average_order_amount"));
    assert.ok(registry.get("paid_order_count"));
  });

  await test("five certified metrics compile deterministically", () => {
    for (const metric of registry.listCertified()) {
      const result = compileCertifiedMetric({ metric });
      assert.equal(result.ok, true, `${metric.metric}: ${result.reason}`);
      assert.ok(result.sql);
    }

    const average = compileCertifiedMetric({
      metric: registry.get("average_order_amount")!,
    });
    assert.match(average.sql!, /AVG\("orders"\."amount"\)/i);

    const paid = compileCertifiedMetric({
      metric: registry.get("paid_order_count")!,
    });
    assert.match(paid.sql!, /COUNT\("orders"\."id"\)/i);
    assert.match(paid.sql!, /"orders"\."status"\s*=\s*\?/i);
    assert.deepEqual(paid.params, ["paid"]);
  });

  await test("订单总额按城市编译含 JOIN 与默认过滤", () => {
    const metric = registry.get("order_total_amount")!;
    const result = compileCertifiedMetric({
      metric,
      dimensions: ["city"],
      filters: [
        { field: "users.city", operator: "=", value: "北京" },
      ],
    });
    assert.equal(result.ok, true, result.reason);
    assert.match(result.sql!, /JOIN\s+"users"/i);
    assert.match(result.sql!, /SUM\("orders"\."amount"\)/i);
    assert.match(result.sql!, /"orders"\."status"\s+IN/i);
    assert.ok(result.params?.includes("北京"));
    assert.ok(result.params?.includes("paid"));
  });

  await test("entity filter adds JOIN without exposing the dimension", () => {
    const metric = registry.get("order_total_amount")!;
    const result = compileCertifiedMetric({
      metric,
      filters: [{ field: "users.name", operator: "=", value: "Alice" }],
    });
    assert.equal(result.ok, true, result.reason);
    assert.match(result.sql!, /JOIN\s+"users"/i);
    assert.match(result.sql!, /"users"\."name"\s*=\s*\?/i);
    assert.ok(result.params?.includes("Alice"));
  });

  await test("business query entity inference keeps names separate from time phrases", () => {
    assert.equal(inferEntityName("查询 Alice 这个月的销售额"), "Alice");
    assert.equal(inferEntityName("给我查询一下张三这个月的销售额"), "张三");
    assert.equal(inferEntityName("Alice sales this month"), "Alice");
    assert.equal(inferEntityName("统计上海用户本月的销售额"), undefined);
    assert.ok(
      registry
        .matchByQuery("Alice sales this month")
        .some((metric) => metric.metric === "order_total_amount"),
    );
  });

  await test("多对多 fanout 拒绝编译", () => {
    const metric = registry.get("order_total_amount")!;
    const evil = {
      ...metric,
      joinGraph: [
        {
          name: "bad",
          from: "orders",
          to: "users",
          fromKey: "user_id",
          toKey: "id",
          cardinality: "many_to_many" as const,
        },
      ],
      dimensions: [
        ...metric.dimensions.filter((d) => d.name === "city"),
      ].map((d) => ({ ...d, joinPath: "bad" })),
    };
    const result = compileCertifiedMetric({
      metric: evil,
      dimensions: ["city"],
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /fanout/i);
  });

  await test("自然语言匹配订单总额", () => {
    const hits = registry.matchByQuery("北京用户订单总额");
    assert.ok(hits.some((h) => h.metric === "order_total_amount"));
    const marketingHits = registry.matchByQuery("张三本季度营销额");
    assert.ok(marketingHits.some((h) => h.metric === "order_total_amount"));
  });

  await test("按月份趋势编译时间桶并保持时间顺序", () => {
    assert.equal(inferTimeGrain("按月份统计订单数量，展示趋势"), "month");
    assert.equal(inferTimeGrain("本月订单总额"), undefined);
    const metric = registry.get("order_count")!;
    const result = compileCertifiedMetric({
      metric,
      timeGrain: "month",
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.logicalQuery?.timeGrain?.grain, "month");
    assert.match(result.sql!, /strftime\('%Y-%m'/i);
    assert.match(result.sql!, /GROUP BY/i);
    assert.match(result.sql!, /ORDER BY/i);
  });
}
