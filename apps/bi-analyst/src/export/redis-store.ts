import { randomUUID } from "node:crypto";
import type { RedisCacheBackend } from "../cache/redis-query-cache.js";
import {
  readRedisJson,
  redisKeySegment,
  withRedisLock,
  writeRedisJson,
} from "../state/redis-state.js";
import {
  applyCsvWatermark,
  publicExportJob,
  rowsToCsv,
  type CreateExportJobInput,
  type ExportJob,
  type ExportJobStore,
} from "./csv.js";
import { decryptExportPayload, encryptExportPayload } from "./encrypt.js";

export class RedisExportJobStore implements ExportJobStore {
  constructor(
    private readonly backend: RedisCacheBackend,
    private readonly encryptionSecret: string,
    private readonly keyPrefix = "bi:state:v1:export:",
  ) {
    if (encryptionSecret.length < 32) {
      throw new Error("EXPORT_ENCRYPTION_SECRET must contain at least 32 characters");
    }
  }

  create(): ExportJob {
    throw new Error("RedisExportJobStore requires createAsync()");
  }

  get(): ExportJob | undefined {
    throw new Error("RedisExportJobStore requires getAsync()");
  }

  getInTenant(): ExportJob | undefined {
    throw new Error("RedisExportJobStore requires getInTenantAsync()");
  }

  approve(): ExportJob {
    throw new Error("RedisExportJobStore requires approveAsync()");
  }

  reject(): ExportJob {
    throw new Error("RedisExportJobStore requires rejectAsync()");
  }

  takeDownload(): { csv: string; job: ExportJob } {
    throw new Error("RedisExportJobStore requires takeDownloadAsync()");
  }

  purgeExpired(): number {
    return 0;
  }

  async createAsync(input: CreateExportJobInput): Promise<ExportJob> {
    const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
    const id = `exp-${randomUUID()}`;
    const now = Date.now();
    const job: ExportJob = {
      id,
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      requestId: input.requestId,
      status: "running",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      requiresApproval: Boolean(input.requireApproval),
      downloadCount: 0,
      maxDownloads: Math.max(1, input.maxDownloads ?? 1),
    };

    try {
      let csv = rowsToCsv(input.columns, input.rows);
      if (input.watermark !== false) {
        csv = applyCsvWatermark(csv, {
          tenantId: input.tenantId,
          subjectId: input.subjectId,
          requestId: input.requestId,
          jobId: id,
          exportedAt: job.createdAt,
        });
      }
      job.csv = encryptExportPayload(csv, this.encryptionSecret);
      job.encrypted = true;
      job.rowCount = input.rows.length;
      job.status = job.requiresApproval ? "pending_approval" : "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }

    await this.persist(job);
    return publicExportJob(job);
  }

  async getAsync(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): Promise<ExportJob | undefined> {
    const job = await this.read(tenantId, jobId);
    if (!job || job.subjectId !== subjectId) return undefined;
    return publicExportJob(job);
  }

  async getInTenantAsync(
    tenantId: string,
    jobId: string,
  ): Promise<ExportJob | undefined> {
    const job = await this.read(tenantId, jobId);
    return job ? publicExportJob(job) : undefined;
  }

  async approveAsync(
    tenantId: string,
    jobId: string,
    approverSubjectId: string,
  ): Promise<ExportJob> {
    return this.update(tenantId, jobId, (job) => {
      if (job.status !== "pending_approval") {
        throw new Error(`Export job cannot be approved from status ${job.status}`);
      }
      if (job.subjectId === approverSubjectId) {
        throw new Error("Export owners cannot approve their own jobs");
      }
      job.status = "completed";
      job.approvedBy = approverSubjectId;
      job.approvedAt = new Date().toISOString();
      return { result: publicExportJob(job), job };
    });
  }

  async rejectAsync(
    tenantId: string,
    jobId: string,
    rejectorSubjectId: string,
    reason?: string,
  ): Promise<ExportJob> {
    return this.update(tenantId, jobId, (job) => {
      if (job.status !== "pending_approval") {
        throw new Error(`Export job cannot be rejected from status ${job.status}`);
      }
      if (job.subjectId === rejectorSubjectId) {
        throw new Error("Export owners cannot reject their own jobs");
      }
      job.status = "rejected";
      job.rejectedBy = rejectorSubjectId;
      job.rejectedAt = new Date().toISOString();
      job.rejectReason = reason;
      job.csv = undefined;
      return { result: publicExportJob(job), job };
    });
  }

  async takeDownloadAsync(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): Promise<{ csv: string; job: ExportJob }> {
    return this.update(tenantId, jobId, (job) => {
      if (job.subjectId !== subjectId) throw new Error("Export job not found");
      if (job.status === "pending_approval") {
        throw new Error("Export approval is required");
      }
      if (job.status === "rejected") throw new Error("Export job was rejected");
      if (job.requiresApproval && (!job.approvedBy || !job.approvedAt)) {
        throw new Error("Export approval is missing or invalid");
      }
      if (job.status !== "completed" || !job.csv) {
        throw new Error("Export file is unavailable");
      }
      if (job.downloadCount >= job.maxDownloads) {
        job.status = "expired";
        job.csv = undefined;
        throw new Error("Export download limit reached");
      }

      const csv = job.encrypted
        ? decryptExportPayload(job.csv, this.encryptionSecret)
        : job.csv;
      job.downloadCount += 1;
      if (job.downloadCount >= job.maxDownloads) {
        job.status = "expired";
        job.csv = undefined;
      }
      return { result: { csv, job: publicExportJob(job) }, job };
    });
  }

  async purgeExpiredAsync(): Promise<number> {
    return 0;
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.backend.ping?.();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  private async update<T>(
    tenantId: string,
    jobId: string,
    mutate: (job: ExportJob) => { result: T; job: ExportJob },
  ): Promise<T> {
    const key = this.key(tenantId, jobId);
    return withRedisLock(this.backend, `${key}:lock`, async () => {
      const current = await this.read(tenantId, jobId);
      if (!current) throw new Error("Export job not found or expired");
      const { result, job } = mutate(current);
      await this.persist(job);
      return result;
    });
  }

  private async read(
    tenantId: string,
    jobId: string,
  ): Promise<ExportJob | undefined> {
    const key = this.key(tenantId, jobId);
    const job = await readRedisJson<ExportJob>(this.backend, key);
    if (!job || job.tenantId !== tenantId || job.id !== jobId) return undefined;
    if (Date.parse(job.expiresAt) <= Date.now()) {
      await this.backend.del([key]);
      return undefined;
    }
    return job;
  }

  private async persist(job: ExportJob): Promise<void> {
    const remainingMs = Date.parse(job.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      await this.backend.del([this.key(job.tenantId, job.id)]);
      return;
    }
    await writeRedisJson(
      this.backend,
      this.key(job.tenantId, job.id),
      job,
      Math.ceil(remainingMs / 1000),
    );
  }

  private key(tenantId: string, jobId: string): string {
    return `${this.keyPrefix}${redisKeySegment(tenantId)}:${redisKeySegment(jobId)}`;
  }
}
