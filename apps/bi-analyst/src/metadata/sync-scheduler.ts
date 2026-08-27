/**
 * 元数据同步外部调度钩子（cron / interval / 进程内定时器）。
 * 不依赖 K8s CronJob；运维可用系统 cron 调 `pnpm sync:metadata`，
 * 或启动本调度器进程（`pnpm sync:metadata:schedule`）。
 */

export type MetadataSyncScheduleMode = "incremental" | "rebuild";

export interface MetadataSyncScheduleConfig {
  /** 是否启用；默认读 METADATA_SYNC_ENABLED */
  enabled: boolean;
  /** 间隔毫秒；默认 METADATA_SYNC_INTERVAL_MS 或 3600000 */
  intervalMs: number;
  mode: MetadataSyncScheduleMode;
  /** 启动后立即跑一次 */
  runOnStart: boolean;
}

export interface MetadataSyncScheduleStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  mode: MetadataSyncScheduleMode;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runCount: number;
  nextRunAt: string | null;
}

export type MetadataSyncJob = () => Promise<void>;

export interface MetadataSyncSchedulerOptions {
  config: MetadataSyncScheduleConfig;
  job: MetadataSyncJob;
  /** 可注入时钟（单测） */
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
}

/**
 * 进程内间隔调度器。同一时刻只跑一个 job；重叠触发会跳过并记 warning。
 */
export class MetadataSyncScheduler {
  private readonly config: MetadataSyncScheduleConfig;
  private readonly job: MetadataSyncJob;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly setTimeoutFn: typeof setTimeout;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private started = false;
  private runCount = 0;
  private lastStartedAt: number | null = null;
  private lastFinishedAt: number | null = null;
  private lastError: string | null = null;
  private lastDurationMs: number | null = null;
  private skippedOverlaps = 0;

  constructor(options: MetadataSyncSchedulerOptions) {
    this.config = options.config;
    this.job = options.job;
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  }

  start(): void {
    if (this.started) return;
    if (!this.config.enabled) return;
    if (this.config.intervalMs < 1_000) {
      throw new Error("METADATA_SYNC_INTERVAL_MS 不得小于 1000");
    }
    this.started = true;
    this.timer = this.setIntervalFn(() => {
      void this.tick();
    }, this.config.intervalMs);
    if (this.config.runOnStart) {
      this.setTimeoutFn(() => {
        void this.tick();
      }, 0);
    }
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** 手动触发一次（API / 脚本钩子） */
  async runOnce(): Promise<void> {
    await this.tick(true);
  }

  getStatus(): MetadataSyncScheduleStatus {
    const next =
      this.started && this.config.enabled
        ? new Date(
            (this.lastFinishedAt ?? this.now()) + this.config.intervalMs,
          ).toISOString()
        : null;
    return {
      enabled: this.config.enabled,
      running: this.inFlight,
      intervalMs: this.config.intervalMs,
      mode: this.config.mode,
      lastStartedAt: this.lastStartedAt
        ? new Date(this.lastStartedAt).toISOString()
        : null,
      lastFinishedAt: this.lastFinishedAt
        ? new Date(this.lastFinishedAt).toISOString()
        : null,
      lastError: this.lastError,
      lastDurationMs: this.lastDurationMs,
      runCount: this.runCount,
      nextRunAt: next,
    };
  }

  getSkippedOverlaps(): number {
    return this.skippedOverlaps;
  }

  private async tick(force = false): Promise<void> {
    if (!force && !this.config.enabled) return;
    if (this.inFlight) {
      this.skippedOverlaps += 1;
      return;
    }
    this.inFlight = true;
    const started = this.now();
    this.lastStartedAt = started;
    this.lastError = null;
    try {
      await this.job();
      this.runCount += 1;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.lastFinishedAt = this.now();
      this.lastDurationMs = this.lastFinishedAt - started;
      this.inFlight = false;
    }
  }
}

export function parseMetadataSyncScheduleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MetadataSyncScheduleConfig {
  const enabled =
    env.METADATA_SYNC_ENABLED === "1" ||
    env.METADATA_SYNC_ENABLED === "true";
  const rawInterval = Number(env.METADATA_SYNC_INTERVAL_MS ?? "3600000");
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : 3_600_000;
  const mode: MetadataSyncScheduleMode =
    env.METADATA_SYNC_MODE === "rebuild" ? "rebuild" : "incremental";
  const runOnStart =
    env.METADATA_SYNC_RUN_ON_START === "1" ||
    env.METADATA_SYNC_RUN_ON_START === "true";
  return { enabled, intervalMs, mode, runOnStart };
}
