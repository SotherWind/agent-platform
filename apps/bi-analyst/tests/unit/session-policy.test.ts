import assert from "node:assert/strict";
import { AuthError } from "../../src/auth/principal.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { InMemorySessionStore } from "../../src/session/store.js";
import { test, section } from "../helpers/runner.js";

export async function testSessionPolicyInvalidation() {
  section("策略变更会话失效");

  await test("policyVersion 变更后旧会话被拒绝", () => {
    const store = new InMemorySessionStore();
    const principal = createTestPrincipal({
      subjectId: "user-a",
      tenantId: "tenant-1",
    });

    store.registerOrValidate(principal, "sess-1", "1");

    assert.throws(
      () => store.registerOrValidate(principal, "sess-1", "2"),
      (err: unknown) =>
        err instanceof AuthError && err.code === "policy_stale",
    );
  });

  await test("相同 policyVersion 可续期", () => {
    const store = new InMemorySessionStore();
    const principal = createTestPrincipal({
      subjectId: "user-a",
      tenantId: "tenant-1",
    });
    const record = store.registerOrValidate(principal, "sess-2", "1");
    const again = store.registerOrValidate(principal, "sess-2", "1");
    assert.equal(again.sessionId, record.sessionId);
    assert.equal(again.policyVersion, "1");
  });
}
