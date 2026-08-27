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
  | "request.failed"
  | "export.created"
  | "export.approved"
  | "export.rejected"
  | "export.downloaded"
  | "history.accessed"
  | "history.deleted"
  | "history.purged"
  | "cache.invalidated"
  | "slo.alert"
  | "model.canary_set"
  | "model.promoted"
  | "model.rolled_back"
  | "metadata.review_decided"
  | "metadata.draft_generated"
  | "metadata.alias_rolled_back"
  | "metadata.sync_applied"
  | "feedback.created"
  | "analysis_job.created"
  | "analysis_job.completed"
  | "analysis_job.failed"
  | "analysis_job.cancelled"
  | "secret.resolved"
  | "secret.rotation_detected";

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
      metadata: redactConsoleMetadata(event.metadata),
      timestamp: new Date().toISOString(),
    };
    console.info("[audit:event]", JSON.stringify(payload));
  }
}

const CONSOLE_SENSITIVE_KEYS = /(?:sql|query|token|secret|password|claim|row|column)/i;

function redactConsoleMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (CONSOLE_SENSITIVE_KEYS.test(key)) continue;
    if (typeof value === "string") {
      safe[key] = value.length > 200 ? `${value.slice(0, 200)}...` : value;
    } else if (Array.isArray(value)) {
      safe[key] = value.length > 20 ? `[${value.length} items]` : value;
    } else {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
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
