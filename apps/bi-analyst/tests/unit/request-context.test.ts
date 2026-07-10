import assert from "node:assert/strict";
import { createRequestContext } from "../../src/runtime/request-context.js";
import { createTestPrincipal } from "../../src/auth/principal.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import { getTestRuntimeProfile } from "../helpers/profile.js";
import { test, section } from "../helpers/runner.js";

export async function testRequestContext() {
  section("RequestContext 可信运行时上下文");

  await test("创建 requestId/traceId 与 deadline", () => {
    const principal = createTestPrincipal();
    const profile = getTestRuntimeProfile();
    const ctx = createRequestContext({
      principal,
      policySnapshot: createDefaultAccessPolicy(principal),
      runtimeProfile: profile,
      requestId: "req-1",
      traceId: "trace-1",
      timeoutMs: 1000,
    });

    assert.equal(ctx.requestId, "req-1");
    assert.equal(ctx.traceId, "trace-1");
    assert.equal(ctx.principal.subjectId, "user-test");
    assert.ok(ctx.deadlineAt > Date.now());
    assert.equal(ctx.abortSignal.aborted, false);
  });
}
