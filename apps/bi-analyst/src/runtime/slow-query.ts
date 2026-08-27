/**
 * 慢查询采样记录（Phase E）：在 history 之外保留 EXPLAIN 摘要与执行元数据。
 */

export interface SlowQuerySample {
  id: string;
  tenantId: string;
  subjectId: string;
  requestId: string;
  traceId?: string;
  dataSourceId?: string;
  durationMs: number;
  rowCount?: number;
  failureKind?: string;
  /** 脱敏后的 SQL 摘要（截断） */
  sqlPreview?: string;
  /** EXPLAIN / 计划摘要（截断） */
  explainSummary?: string;
  createdAt: string;
}

export interface SlowQueryListOptions {
  tenantId: string;
  minDurationMs?: number;
  limit?: number;
  offset?: number;
  dataSourceId?: string;
}

export interface SlowQueryRecorder {
  record(sample: SlowQuerySample): void;
  list(options: SlowQueryListOptions): SlowQuerySample[];
  clear?(): void;
}

export class InMemorySlowQueryRecorder implements SlowQueryRecorder {
  private readonly samples: SlowQuerySample[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 2_000) {
    this.maxSamples = maxSamples;
  }

  record(sample: SlowQuerySample): void {
    this.samples.push({
      ...sample,
      sqlPreview: truncate(sample.sqlPreview, 500),
      explainSummary: truncate(sample.explainSummary, 1_200),
    });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  list(options: SlowQueryListOptions): SlowQuerySample[] {
    const minMs = options.minDurationMs ?? 1_000;
    const limit = Math.min(Math.max(1, options.limit ?? 20), 100);
    const offset = Math.max(0, options.offset ?? 0);
    return this.samples
      .filter((s) => s.tenantId === options.tenantId)
      .filter((s) => s.durationMs >= minMs)
      .filter(
        (s) =>
          !options.dataSourceId || s.dataSourceId === options.dataSourceId,
      )
      .slice()
      .reverse()
      .slice(offset, offset + limit);
  }

  clear(): void {
    this.samples.length = 0;
  }
}

/** 仅当耗时达到阈值时写入 */
export function maybeRecordSlowQuery(
  recorder: SlowQueryRecorder | undefined,
  sample: SlowQuerySample,
  thresholdMs = 1_000,
): void {
  if (!recorder) return;
  if (sample.durationMs < thresholdMs) return;
  recorder.record(sample);
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value == null) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
