import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  decryptExportPayload,
  encryptExportPayload,
} from "../export/encrypt.js";

export type AnalysisJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AnalysisJob {
  id: string;
  tenantId: string;
  subjectId: string;
  requestId: string;
  traceId: string;
  query: string;
  status: AnalysisJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export interface CreateAnalysisJobInput {
  tenantId: string;
  subjectId: string;
  requestId: string;
  traceId: string;
  query: string;
}

export interface AnalysisJobStore {
  create(input: CreateAnalysisJobInput): AnalysisJob;
  get(tenantId: string, subjectId: string, id: string): AnalysisJob | undefined;
  update(id: string, patch: Partial<Pick<AnalysisJob, "status" | "startedAt" | "completedAt" | "result" | "error">>): AnalysisJob | undefined;
  cancel(tenantId: string, subjectId: string, id: string): AnalysisJob | undefined;
  purgeOlderThan?(retentionMs: number, now?: Date): number;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): void | Promise<void>;
}

function copyJob(job: AnalysisJob): AnalysisJob {
  return { ...job };
}

export class InMemoryAnalysisJobStore implements AnalysisJobStore {
  protected readonly jobs = new Map<string, AnalysisJob>();

  create(input: CreateAnalysisJobInput): AnalysisJob {
    const query = input.query.trim();
    if (!query) throw new Error("Analysis job query must not be empty");
    const now = new Date().toISOString();
    const job: AnalysisJob = {
      id: `job-${randomUUID()}`,
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      requestId: input.requestId,
      traceId: input.traceId,
      query,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return copyJob(job);
  }

  get(tenantId: string, subjectId: string, id: string): AnalysisJob | undefined {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId || job.subjectId !== subjectId) return undefined;
    return copyJob(job);
  }

  update(
    id: string,
    patch: Partial<Pick<AnalysisJob, "status" | "startedAt" | "completedAt" | "result" | "error">>,
  ): AnalysisJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (
      patch.status &&
      ["completed", "failed", "cancelled"].includes(job.status) &&
      patch.status !== job.status
    ) {
      return copyJob(job);
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return copyJob(job);
  }

  cancel(tenantId: string, subjectId: string, id: string): AnalysisJob | undefined {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId || job.subjectId !== subjectId) return undefined;
    if (job.status === "queued" || job.status === "running") {
      this.update(id, { status: "cancelled", completedAt: new Date().toISOString() });
    }
    return copyJob(this.jobs.get(id)!);
  }

  purgeOlderThan(retentionMs: number, now = new Date()): number {
    const cutoff = now.getTime() - Math.max(0, retentionMs);
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.updatedAt) < cutoff) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

export class PersistentAnalysisJobStore extends InMemoryAnalysisJobStore {
  constructor(
    private readonly filePath: string,
    private readonly encryptionSecret?: string,
  ) {
    super();
    this.load();
  }

  override create(input: CreateAnalysisJobInput): AnalysisJob {
    const job = super.create(input);
    this.save();
    return job;
  }

  override update(
    id: string,
    patch: Partial<Pick<AnalysisJob, "status" | "startedAt" | "completedAt" | "result" | "error">>,
  ): AnalysisJob | undefined {
    const job = super.update(id, patch);
    if (job) this.save();
    return job;
  }

  override cancel(tenantId: string, subjectId: string, id: string): AnalysisJob | undefined {
    const job = super.cancel(tenantId, subjectId, id);
    if (job) this.save();
    return job;
  }

  override purgeOlderThan(retentionMs: number, now = new Date()): number {
    const removed = super.purgeOlderThan(retentionMs, now);
    if (removed > 0) this.save();
    return removed;
  }

  private load(): void {
    try {
      const outer = JSON.parse(fs.readFileSync(path.resolve(this.filePath), "utf8")) as {
        encrypted?: string;
        jobs?: AnalysisJob[];
      };
      const parsed = outer.encrypted
        ? this.encryptionSecret
          ? (JSON.parse(decryptExportPayload(outer.encrypted, this.encryptionSecret)) as {
              jobs?: AnalysisJob[];
            })
          : (() => {
              throw new Error("Encrypted analysis job state requires ANALYSIS_STATE_ENCRYPTION_SECRET");
            })()
        : outer;
      let interrupted = false;
      if (!Array.isArray(parsed.jobs)) {
        throw new Error("Analysis job state is missing a jobs array");
      }
      for (const job of parsed.jobs) {
        if (job?.id && job.tenantId && job.subjectId && job.requestId) {
          if (job.status === "queued" || job.status === "running") {
            const now = new Date().toISOString();
            this.jobs.set(job.id, {
              ...job,
              status: "failed",
              updatedAt: now,
              completedAt: now,
              error: "Analysis job was interrupted by process restart",
            });
            interrupted = true;
          } else {
            this.jobs.set(job.id, job);
          }
        }
      }
      if (interrupted) this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw new Error(
        `Unable to load analysis job state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private save(): void {
    const absolute = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}`;
    const plain = JSON.stringify({ jobs: [...this.jobs.values()] });
    const payload = this.encryptionSecret
      ? JSON.stringify({ encrypted: encryptExportPayload(plain, this.encryptionSecret) })
      : plain;
    fs.writeFileSync(temporary, payload, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, absolute);
  }
}

export class AnalysisJobRunner {
  private readonly pending: Array<{
    jobId: string;
    work: (signal: AbortSignal) => Promise<unknown>;
  }> = [];
  private readonly controllers = new Map<string, AbortController>();
  private active = 0;
  private closed = false;

  constructor(
    private readonly store: AnalysisJobStore,
    private readonly concurrency = 2,
  ) {}

  enqueue(jobId: string, work: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.closed) throw new Error("Analysis job runner is closed");
    this.pending.push({ jobId, work });
    void this.drain();
  }

  cancel(jobId: string): void {
    this.controllers.get(jobId)?.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.pending.length = 0;
    while (this.active > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.active < Math.max(1, this.concurrency) && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.active += 1;
      void this.run(next).finally(() => {
        this.active -= 1;
        void this.drain();
      });
    }
  }

  private async run(next: {
    jobId: string;
    work: (signal: AbortSignal) => Promise<unknown>;
  }): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(next.jobId, controller);
    const current = this.store.update(next.jobId, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    if (!current || current.status === "cancelled") {
      this.controllers.delete(next.jobId);
      return;
    }
    try {
      const result = await next.work(controller.signal);
      if (controller.signal.aborted) {
        this.store.update(next.jobId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
      } else {
        this.store.update(next.jobId, {
          status: "completed",
          completedAt: new Date().toISOString(),
          result,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.store.update(next.jobId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
      } else {
        this.store.update(next.jobId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.controllers.delete(next.jobId);
    }
  }
}
