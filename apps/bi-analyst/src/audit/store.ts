import type { StructuredAuditEvent } from "./events.js";

export interface AuditQuery {
  tenantId: string;
  subjectId?: string;
  requestId?: string;
  event?: string;
  limit?: number;
  offset?: number;
  sinceMs?: number;
}

export interface AuditStore {
  append(event: StructuredAuditEvent): void;
  query(filter: AuditQuery): StructuredAuditEvent[];
  purgeOlderThan(retentionMs: number): number;
  size(): number;
  /** Persistent stores expose authoritative asynchronous operations. */
  appendAsync?(event: StructuredAuditEvent): Promise<void>;
  queryAsync?(filter: AuditQuery): Promise<StructuredAuditEvent[]>;
  purgeOlderThanAsync?(retentionMs: number): Promise<number>;
  sizeAsync?(): Promise<number>;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): Promise<void>;
}

/** 字段分级：summary 隐藏可能含 SQL/敏感细节的 metadata */
export type AuditFieldLevel = "full" | "summary";

const SENSITIVE_META_KEYS = new Set([
  "generatedSql",
  "sql",
  "errorDetail",
  "rawError",
  "connection",
  "secretRef",
]);

export function redactAuditEvent(
  event: StructuredAuditEvent,
  level: AuditFieldLevel,
): StructuredAuditEvent {
  if (level === "full") return event;
  const meta = event.metadata;
  if (!meta) {
    return { ...event, durationMs: event.durationMs, rowCount: event.rowCount };
  }
  const safeMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_META_KEYS.has(k)) continue;
    if (typeof v === "string" && v.length > 200) {
      safeMeta[k] = `${v.slice(0, 200)}…`;
      continue;
    }
    safeMeta[k] = v;
  }
  return {
    ...event,
    dataSourceId: undefined,
    metadata: Object.keys(safeMeta).length ? safeMeta : undefined,
  };
}

export function redactAuditEvents(
  events: StructuredAuditEvent[],
  level: AuditFieldLevel,
): StructuredAuditEvent[] {
  return events.map((e) => redactAuditEvent(e, level));
}

/** 内存审计存储：单测/本地；生产可替换为 DB 实现 */
export class InMemoryAuditStore implements AuditStore {
  private readonly events: StructuredAuditEvent[] = [];

  append(event: StructuredAuditEvent): void {
    this.events.push(event);
  }

  query(filter: AuditQuery): StructuredAuditEvent[] {
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
    const offset = Math.max(0, filter.offset ?? 0);
    const since = filter.sinceMs ? Date.now() - filter.sinceMs : 0;
    return this.events
      .filter((e) => e.tenantId === filter.tenantId)
      .filter((e) => !filter.subjectId || e.subjectId === filter.subjectId)
      .filter((e) => !filter.requestId || e.requestId === filter.requestId)
      .filter((e) => !filter.event || e.event === filter.event)
      .filter((e) => !since || Date.parse(e.timestamp) >= since)
      .slice()
      .reverse()
      .slice(offset, offset + limit);
  }

  purgeOlderThan(retentionMs: number): number {
    if (retentionMs <= 0) {
      const n = this.events.length;
      this.events.length = 0;
      return n;
    }
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    while (this.events.length > 0) {
      const ts = Date.parse(this.events[0]!.timestamp);
      if (ts >= cutoff) break;
      this.events.shift();
      removed += 1;
    }
    return removed;
  }

  size(): number {
    return this.events.length;
  }
}
