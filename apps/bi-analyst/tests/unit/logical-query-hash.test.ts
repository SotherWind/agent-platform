import assert from "node:assert/strict";
import { hashLogicalQuery } from "../../src/cache/logical-query-hash.js";
import { PermissionAwareQueryCache } from "../../src/cache/query-cache.js";
import type { LogicalQuery } from "../../src/query-plan/logical-query.js";
import { test, section } from "../helpers/runner.js";

export async function testLogicalQueryHash() {
  section("logicalQueryHash 缓存分层");

  const base: LogicalQuery = {
    source: "ecommerce_sqlite",
    measures: [{ ref: "orders.amount", aggregation: "sum" }],
    dimensions: [{ ref: "orders.status" }],
    filters: [
      { field: "orders.status", operator: "in", value: ["paid", "shipped"] },
    ],
    metricId: "order_total_amount",
  };

  await test("相同 LogicalQuery 同 hash（字段顺序无关）", () => {
    const a = hashLogicalQuery(base);
    const b = hashLogicalQuery({
      filters: base.filters,
      dimensions: base.dimensions,
      measures: base.measures,
      source: base.source,
      metricId: base.metricId,
    });
    assert.equal(a, b);
    assert.equal(a.length, 32);
  });

  await test("不同 measure 产生不同 hash", () => {
    const other = hashLogicalQuery({
      ...base,
      measures: [{ ref: "orders.amount", aggregation: "avg" }],
    });
    assert.notEqual(hashLogicalQuery(base), other);
  });

  await test("buildKey 含 logicalQueryHash 时 digest 不同", () => {
    const parts = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "1",
      query: "订单总额",
    };
    const k1 = PermissionAwareQueryCache.buildKey(parts);
    const k2 = PermissionAwareQueryCache.buildKey({
      ...parts,
      logicalQueryHash: hashLogicalQuery(base),
    });
    assert.notEqual(k1, k2);
  });

  await test("双 key 写入：无 hash 与有 hash 均可命中", () => {
    const cache = new PermissionAwareQueryCache<string>();
    const plain = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "1",
      query: "订单总额",
      metadataVersion: "v1",
    };
    const hashed = {
      ...plain,
      logicalQueryHash: hashLogicalQuery(base),
    };
    cache.set(PermissionAwareQueryCache.buildKey(plain), plain, "answer");
    cache.set(PermissionAwareQueryCache.buildKey(hashed), hashed, "answer");
    assert.equal(
      cache.get(PermissionAwareQueryCache.buildKey(plain), plain),
      "answer",
    );
    assert.equal(
      cache.get(PermissionAwareQueryCache.buildKey(hashed), hashed),
      "answer",
    );
  });
}
