import type { AuthenticatedPrincipal } from "../../src/auth/types.js";

export function createTestPrincipal(
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return {
    subjectId: "user-test",
    tenantId: "tenant-1",
    roles: ["analyst"],
    claims: {},
    ...overrides,
  };
}
