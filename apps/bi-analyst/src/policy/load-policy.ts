import type { RuntimeProfile } from "../config/types.js";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import { withAuthorizedDataSources } from "./policy-provider.js";

export function loadPolicyForPrincipal(
  principal: AuthenticatedPrincipal,
  profile: RuntimeProfile,
) {
  const loaded = profile.policyProvider.loadPolicy(principal);
  if (typeof (loaded as { then?: unknown }).then === "function") {
    throw new Error("Async PolicyProvider requires the async policy loader");
  }
  const base = loaded as import("./access-policy.js").AccessPolicy;
  const authorized = profile.dataSourceRegistry.getAuthorized(principal, base);
  return withAuthorizedDataSources(
    base,
    authorized.map((source) => source.id),
  );
}

export async function loadPolicyForPrincipalAsync(
  principal: AuthenticatedPrincipal,
  profile: RuntimeProfile,
) {
  const base = await profile.policyProvider.loadPolicy(principal);
  const authorized = profile.dataSourceRegistry.getAuthorized(principal, base);
  return withAuthorizedDataSources(
    base,
    authorized.map((source) => source.id),
  );
}
