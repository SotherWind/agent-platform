import assert from "node:assert/strict";
import { createDatabase } from "../../src/db/seed.js";
import {
  InMemorySessionStore,
  SqliteSessionStore,
} from "../../src/session/store.js";
import { AuthError } from "../../src/auth/principal.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { test, section } from "../helpers/runner.js";

export async function testSessionStore() {
  section("SessionStore (TTL + policy 失效)");

  await test("InMemorySessionStore 首次注册会话", () => {
    const store = new InMemorySessionStore();
    const principal = createTestPrincipal();
    const record = store.registerOrValidate(principal, "sess-1", "1");
    assert.equal(record.sessionId, "sess-1");
    assert.equal(record.policyVersion, "1");
  });

  await test("policyVersion 变更拒绝旧会话", () => {
    const store = new InMemorySessionStore();
    const principal = createTestPrincipal();
    store.registerOrValidate(principal, "sess-1", "1");
    assert.throws(
      () => store.registerOrValidate(principal, "sess-1", "2"),
      (err: AuthError) => err.code === "policy_stale",
    );
  });

  await test("SqliteSessionStore 持久化并可读取", () => {
    const db = createDatabase(":memory:");
    const store = new SqliteSessionStore(db);
    const principal = createTestPrincipal();
    store.registerOrValidate(principal, "sess-sqlite", "1");
    const loaded = store.get("tenant-1", "user-test", "sess-sqlite");
    assert.ok(loaded);
    assert.equal(loaded?.policyVersion, "1");
    db.close();
  });

  await test("过期会话 purge 后不可读取", () => {
    const store = new InMemorySessionStore(1000);
    const principal = createTestPrincipal();
    store.registerOrValidate(principal, "sess-expire", "1");
    const purged = store.purgeExpired(new Date(Date.now() + 2000));
    assert.equal(purged, 1);
    assert.equal(store.get("tenant-1", "user-test", "sess-expire"), null);
  });
}
