export interface QueryHistoryRecord {
  id: string;
  tenantId: string;
  subjectId: string;
  sessionId?: string;
  requestId: string;
  traceId: string;
  query: string;
  finalAnswerPreview: string;
  queryPath: string | null;
  dataSourceId?: string;
  needsClarification: boolean;
  createdAt: string;
  /** 端到端耗时（毫秒），用于慢查列表 */
  durationMs?: number;
  /** 仅缓存导出用；不含 debug SQL */
  rows?: Record<string, unknown>[];
  columns?: string[];
}

export interface QueryHistoryListOptions {
  limit?: number;
  offset?: number;
  /** 仅返回耗时 ≥ 该阈值的记录 */
  minDurationMs?: number;
}

export interface QueryHistoryStore {
  append(record: QueryHistoryRecord): void;
  list(
    tenantId: string,
    subjectId: string,
    options?: number | QueryHistoryListOptions,
  ): QueryHistoryRecord[];
  getByRequestId(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): QueryHistoryRecord | undefined;
  /** Persistent stores expose authoritative asynchronous operations. */
  appendAsync?(record: QueryHistoryRecord): Promise<void>;
  listAsync?(
    tenantId: string,
    subjectId: string,
    options?: number | QueryHistoryListOptions,
  ): Promise<QueryHistoryRecord[]>;
  getByRequestIdAsync?(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): Promise<QueryHistoryRecord | undefined>;
  purgeOlderThan?(retentionMs: number, now?: Date): number;
  purgeOlderThanAsync?(retentionMs: number, now?: Date): Promise<number>;
  purgeTenantOlderThan?(tenantId: string, retentionMs: number, now?: Date): number;
  purgeTenantOlderThanAsync?(tenantId: string, retentionMs: number, now?: Date): Promise<number>;
  deleteByRequestId?(tenantId: string, subjectId: string, requestId: string): number;
  deleteByRequestIdAsync?(tenantId: string, subjectId: string, requestId: string): Promise<number>;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): Promise<void>;
}

function normalizeListOptions(
  options?: number | QueryHistoryListOptions,
): Required<Pick<QueryHistoryListOptions, "limit" | "offset">> &
  Pick<QueryHistoryListOptions, "minDurationMs"> {
  if (typeof options === "number") {
    return { limit: options, offset: 0 };
  }
  return {
    limit: options?.limit ?? 20,
    offset: Math.max(0, options?.offset ?? 0),
    minDurationMs: options?.minDurationMs,
  };
}

export class InMemoryQueryHistoryStore implements QueryHistoryStore {
  private readonly records: QueryHistoryRecord[] = [];

  append(record: QueryHistoryRecord): void {
    this.records.push(record);
  }

  list(
    tenantId: string,
    subjectId: string,
    options?: number | QueryHistoryListOptions,
  ): QueryHistoryRecord[] {
    const { limit, offset, minDurationMs } = normalizeListOptions(options);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    return this.records
      .filter((r) => r.tenantId === tenantId && r.subjectId === subjectId)
      .filter(
        (r) =>
          minDurationMs === undefined ||
          (typeof r.durationMs === "number" && r.durationMs >= minDurationMs),
      )
      .slice()
      .reverse()
      .slice(offset, offset + safeLimit)
      .map(({ rows: _rows, columns: _cols, ...safe }) => safe);
  }

  getByRequestId(
    tenantId: string,
    subjectId: string,
    requestId: string,
  ): QueryHistoryRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const r = this.records[i]!;
      if (
        r.tenantId === tenantId &&
        r.subjectId === subjectId &&
        r.requestId === requestId
      ) {
        return r;
      }
    }
    return undefined;
  }

  purgeOlderThan(retentionMs: number, now = new Date()): number {
    const cutoff = now.getTime() - retentionMs;
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (Date.parse(this.records[i]!.createdAt) < cutoff) {
        this.records.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  purgeTenantOlderThan(tenantId: string, retentionMs: number, now = new Date()): number {
    const cutoff = now.getTime() - retentionMs;
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i]!;
      if (record.tenantId === tenantId && Date.parse(record.createdAt) < cutoff) {
        this.records.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  deleteByRequestId(tenantId: string, subjectId: string, requestId: string): number {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i]!;
      if (
        record.tenantId === tenantId &&
        record.subjectId === subjectId &&
        record.requestId === requestId
      ) {
        this.records.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}
