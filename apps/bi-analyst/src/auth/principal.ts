import type {
  AnalyzeRequest,
  AuthenticatedPrincipal,
  SessionRecord,
} from "./types.js";
import { parseClarificationChoice } from "../query-plan/clarification-resolver.js";
import { AppError } from "../errors/app-error.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unauthenticated"
      | "tenant_mismatch"
      | "session_not_found"
      | "session_forbidden"
      | "policy_stale"
      | "forged_identity",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function parseAnalyzeRequest(body: Record<string, unknown>): AnalyzeRequest {
  const query = body.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new AppError("query must not be empty", "validation_error", 400);
  }

  if ("userId" in body || "tenantId" in body || "roles" in body) {
    throw new AuthError(
      "Identity fields must come from the authenticated request context",
      "forged_identity",
    );
  }

  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clarificationChoice = parseClarificationChoice(
    body.clarificationChoice,
  )?.id;

  return { query: query.trim(), sessionId, clarificationChoice };
}

export function assertSessionOwnership(
  principal: AuthenticatedPrincipal,
  session: SessionRecord | null | undefined,
): void {
  if (!session) {
    throw new AuthError("Session does not exist", "session_not_found");
  }
  if (session.tenantId !== principal.tenantId) {
    throw new AuthError("Tenant mismatch", "tenant_mismatch");
  }
  if (session.subjectId !== principal.subjectId) {
    throw new AuthError("Session access denied", "session_forbidden");
  }
}

export function buildSessionKey(
  tenantId: string,
  subjectId: string,
  sessionId: string,
): string {
  return `${tenantId}:${subjectId}:${sessionId}`;
}
