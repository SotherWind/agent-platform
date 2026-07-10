import type { RuntimeProfile } from "../config/types.js";
import { createDefaultAccessPolicy } from "../policy/access-policy.js";
import { createTestPrincipal } from "../auth/principal.js";
import { createRequestContext, type RequestContext } from "./request-context.js";

/** 仅 development/test 本地 Graph 直调时的兜底上下文；HTTP API 必须显式注入 */
export function createLocalFallbackRequestContext(
  profile: RuntimeProfile,
): RequestContext {
  const principal = createTestPrincipal();
  return createRequestContext({
    principal,
    policySnapshot: createDefaultAccessPolicy(principal),
    runtimeProfile: profile,
  });
}
