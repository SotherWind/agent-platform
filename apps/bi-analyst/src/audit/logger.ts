export interface AuditEvent {
  requestId: string;
  subjectId: string;
  tenantId: string;
  sessionId?: string;
  dataSourceId: string;
  query?: string;
  sql?: string;
  durationMs?: number;
  rowCount?: number;
  failureKind?: string;
  rawError?: string;
  timestamp: string;
}

export interface AuditLogger {
  log(event: AuditEvent): void;
}

/** 默认审计：写入 stderr（Phase 4 可替换为持久化） */
export class ConsoleAuditLogger implements AuditLogger {
  log(event: AuditEvent): void {
    const { rawError: _rawError, sql: _sql, query: _query, ...safe } = event;
    console.info("[audit]", JSON.stringify(safe));
  }
}

let defaultLogger: AuditLogger = new ConsoleAuditLogger();

export function getAuditLogger(): AuditLogger {
  return defaultLogger;
}

export function setAuditLogger(logger: AuditLogger): void {
  defaultLogger = logger;
}

export function auditLog(event: Omit<AuditEvent, "timestamp">): void {
  getAuditLogger().log({ ...event, timestamp: new Date().toISOString() });
}
