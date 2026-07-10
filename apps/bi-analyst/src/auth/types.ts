/** 可信身份主体 —— 必须由认证中间件构造，不可由请求体覆盖 */
export interface AuthenticatedPrincipal {
  subjectId: string;
  tenantId: string;
  roles: string[];
  claims: Record<string, unknown>;
}

/** 前端/API 业务请求体 —— 只收 query 和 sessionId */
export interface AnalyzeRequest {
  query: string;
  sessionId?: string;
}

/** 会话记录（checkpointer 复合键：tenantId + subjectId + sessionId） */
export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  subjectId: string;
  policyVersion: string;
  lastDataSourceId?: string;
  createdAt: string;
  updatedAt: string;
}
