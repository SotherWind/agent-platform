import type { AuthenticatedPrincipal, AnalyzeRequest, SessionRecord } from "./types.js";

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

/** 从请求体剥离不可信身份字段，只保留业务参数 */
export function parseAnalyzeRequest(body: Record<string, unknown>): AnalyzeRequest {
  const query = body.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new AuthError("query 不能为空", "unauthenticated");
  }

  if ("userId" in body || "tenantId" in body || "roles" in body) {
    throw new AuthError(
      "请求体不得包含 userId/tenantId/roles，身份须来自认证上下文",
      "forged_identity",
    );
  }

  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId : undefined;

  return { query: query.trim(), sessionId };
}

/** 校验 session 归属于当前 principal */
export function assertSessionOwnership(
  principal: AuthenticatedPrincipal,
  session: SessionRecord | null | undefined,
): void {
  if (!session) {
    throw new AuthError("会话不存在", "session_not_found");
  }
  if (session.tenantId !== principal.tenantId) {
    throw new AuthError("租户不匹配", "tenant_mismatch");
  }
  if (session.subjectId !== principal.subjectId) {
    throw new AuthError("无权访问该会话", "session_forbidden");
  }
}

/** checkpointer / cache 复合键 */
export function buildSessionKey(
  tenantId: string,
  subjectId: string,
  sessionId: string,
): string {
  return `${tenantId}:${subjectId}:${sessionId}`;
}

/** demo/test 用默认主体 */
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
