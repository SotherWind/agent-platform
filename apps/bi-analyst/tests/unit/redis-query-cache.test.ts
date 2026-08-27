import assert from "node:assert/strict";
import {
  InMemoryRedisCacheBackend,
  RedisPermissionAwareQueryCache,
} from "../../src/cache/redis-query-cache.js";
import { PermissionAwareQueryCache } from "../../src/cache/query-cache.js";
import { test, section } from "../helpers/runner.js";

export async function testRedisQueryCache() {
  section("RedisPermissionAwareQueryCache");

  await test("L1 set/get 与内存合约一致", async () => {
    const backend = new InMemoryRedisCacheBackend();
    const cache = new RedisPermissionAwareQueryCache<string>({
      backend,
      ttlMs: 60_000,
    });
    const parts = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "北京订单",
    };
    const key = PermissionAwareQueryCache.buildKey(parts);
    cache.set(key, parts, "hit");
    assert.equal(cache.get(key, parts), "hit");
    await cache.flush();
    assert.equal(backend.size(), 1);
    assert.equal((await cache.healthCheck()).healthy, true);
  });

  await test("invalidateTenant 同步清 L1 并异步清 L2", async () => {
    const backend = new InMemoryRedisCacheBackend();
    const cache = new RedisPermissionAwareQueryCache<string>({
      backend,
      ttlMs: 60_000,
    });
    const a = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "q1",
    };
    const b = {
      tenantId: "t2",
      subjectId: "u1",
      policyVersion: "v1",
      query: "q2",
    };
    cache.set(PermissionAwareQueryCache.buildKey(a), a, "a");
    cache.set(PermissionAwareQueryCache.buildKey(b), b, "b");
    await cache.flush();
    assert.equal(cache.invalidateTenant("t1"), 1);
    await cache.flush();
    assert.equal(
      cache.get(PermissionAwareQueryCache.buildKey(a), a),
      undefined,
    );
    assert.equal(cache.get(PermissionAwareQueryCache.buildKey(b), b), "b");
    const remaining = await backend.scan("bi:qc:v1:qc:t2:*");
    assert.equal(remaining.length, 1);
  });

  await test("policyVersion 变更 miss", async () => {
    const backend = new InMemoryRedisCacheBackend();
    const cache = new RedisPermissionAwareQueryCache<string>({ backend });
    const parts = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "x",
    };
    const key = PermissionAwareQueryCache.buildKey(parts);
    cache.set(key, parts, "old");
    assert.equal(
      cache.get(key, { ...parts, policyVersion: "v2" }),
      undefined,
    );
  });
}
