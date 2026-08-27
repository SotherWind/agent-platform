/** 轻量 SLO 计数器：本地/测试用；生产可替换为 Prometheus 等 */

export interface SloSnapshot {
  requests: number;
  successes: number;
  failures: number;
  errorRate: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  byCode: Record<string, number>;
}

export interface SloThresholds {
  maxErrorRate: number;
  maxP95LatencyMs: number;
  /** 低于该样本数不触发告警 */
  minSamples?: number;
}

export type SloAlertKind = "error_rate" | "latency_p95";

export interface SloAlert {
  kind: SloAlertKind;
  threshold: number;
  actual: number;
  at: string;
}

export interface SloMonitorSnapshot extends SloSnapshot {
  alerts: SloAlert[];
}

export class SloRecorder {
  private readonly latencies: number[] = [];
  private successes = 0;
  private failures = 0;
  private readonly byCode = new Map<string, number>();

  constructor(private readonly maxSamples = 2_000) {}

  record(input: {
    durationMs: number;
    success: boolean;
    code?: string;
  }): void {
    this.latencies.push(Math.max(0, input.durationMs));
    if (this.latencies.length > this.maxSamples) {
      this.latencies.splice(0, this.latencies.length - this.maxSamples);
    }
    if (input.success) {
      this.successes += 1;
    } else {
      this.failures += 1;
      const code = input.code ?? "unknown";
      this.byCode.set(code, (this.byCode.get(code) ?? 0) + 1);
    }
  }

  snapshot(): SloSnapshot {
    const requests = this.successes + this.failures;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      requests,
      successes: this.successes,
      failures: this.failures,
      errorRate: requests === 0 ? 0 : this.failures / requests,
      latencyMs: {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.length ? sorted[sorted.length - 1]! : 0,
      },
      byCode: Object.fromEntries(this.byCode),
    };
  }

  reset(): void {
    this.latencies.length = 0;
    this.successes = 0;
    this.failures = 0;
    this.byCode.clear();
  }
}

/** 带阈值评估与告警钩子的 SLO 监控 */
export class SloMonitor {
  private readonly alerts: SloAlert[] = [];

  constructor(
    private readonly recorder: SloRecorder,
    private readonly thresholds: SloThresholds,
    private readonly onAlert?: (alert: SloAlert) => void,
    private readonly maxAlerts = 50,
  ) {}

  record(input: {
    durationMs: number;
    success: boolean;
    code?: string;
  }): SloAlert[] {
    this.recorder.record(input);
    return this.evaluate();
  }

  evaluate(): SloAlert[] {
    const snap = this.recorder.snapshot();
    const minSamples = this.thresholds.minSamples ?? 10;
    if (snap.requests < minSamples) return [];

    const fired: SloAlert[] = [];
    const at = new Date().toISOString();

    if (snap.errorRate > this.thresholds.maxErrorRate) {
      fired.push({
        kind: "error_rate",
        threshold: this.thresholds.maxErrorRate,
        actual: snap.errorRate,
        at,
      });
    }
    if (snap.latencyMs.p95 > this.thresholds.maxP95LatencyMs) {
      fired.push({
        kind: "latency_p95",
        threshold: this.thresholds.maxP95LatencyMs,
        actual: snap.latencyMs.p95,
        at,
      });
    }

    for (const alert of fired) {
      this.alerts.push(alert);
      this.onAlert?.(alert);
    }
    while (this.alerts.length > this.maxAlerts) {
      this.alerts.shift();
    }
    return fired;
  }

  snapshot(): SloMonitorSnapshot {
    return {
      ...this.recorder.snapshot(),
      alerts: [...this.alerts],
    };
  }

  reset(): void {
    this.recorder.reset();
    this.alerts.length = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return sorted[idx]!;
}

export function createDefaultSloMonitor(
  onAlert?: (alert: SloAlert) => void,
): SloMonitor {
  return new SloMonitor(
    new SloRecorder(),
    {
      maxErrorRate: 0.05,
      maxP95LatencyMs: 30_000,
      minSamples: 5,
    },
    onAlert,
  );
}
