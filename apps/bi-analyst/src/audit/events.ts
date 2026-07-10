export type AuditEventName =
  | "request.accepted"
  | "auth.validated"
  | "policy.loaded"
  | "datasource.selected"
  | "metadata.retrieved"
  | "metric.matched"
  | "query.plan_built"
  | "sql.generated"
  | "sql.validation_rejected"
  | "sql.executed"
  | "result.redacted"
  | "answer.completed"
  | "request.failed";

export interface StructuredAuditEvent {
  event: AuditEventName;
  requestId: string;
  traceId: string;
  subjectId: string;
  tenantId: string;
  sessionId?: string;
  dataSourceId?: string;
  durationMs?: number;
  rowCount?: number;
  failureKind?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface AuditEmitter {
  emit(event: Omit<StructuredAuditEvent, "timestamp">): void;
}

export class ConsoleAuditEmitter implements AuditEmitter {
  emit(event: Omit<StructuredAuditEvent, "timestamp">): void {
    const payload: StructuredAuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    console.info("[audit:event]", JSON.stringify(payload));
  }
}

let defaultEmitter: AuditEmitter = new ConsoleAuditEmitter();

export function getAuditEmitter(): AuditEmitter {
  return defaultEmitter;
}

export function setAuditEmitter(emitter: AuditEmitter): void {
  defaultEmitter = emitter;
}

export function emitAuditEvent(
  event: Omit<StructuredAuditEvent, "timestamp">,
): void {
  getAuditEmitter().emit(event);
}
