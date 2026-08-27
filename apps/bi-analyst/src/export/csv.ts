import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  decryptExportPayload,
  encryptExportPayload,
} from "./encrypt.js";

/** 防止 CSV/公式注入：前导 = + - @ \t \r 加单引号 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function rowsToCsv(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  const header = columns.map(sanitizeCsvCell).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => sanitizeCsvCell(row[c])).join(","),
  );
  return [header, ...lines].join("\n");
}

export interface CsvWatermarkMeta {
  tenantId: string;
  subjectId: string;
  requestId: string;
  jobId: string;
  exportedAt?: string;
}

/** 在 CSV 顶部写入不可执行注释水印行 */
export function applyCsvWatermark(csv: string, meta: CsvWatermarkMeta): string {
  const at = meta.exportedAt ?? new Date().toISOString();
  const line = `# watermark tenant=${meta.tenantId} subject=${meta.subjectId} requestId=${meta.requestId} jobId=${meta.jobId} at=${at}`;
  return `${line}\n${csv}`;
}

export type ExportJobStatus =
  | "pending"
  | "pending_approval"
  | "running"
  | "completed"
  | "failed"
  | "expired"
  | "rejected";

export interface ExportJob {
  id: string;
  tenantId: string;
  subjectId: string;
  requestId: string;
  status: ExportJobStatus;
  createdAt: string;
  expiresAt: string;
  error?: string;
  csv?: string;
  rowCount?: number;
  requiresApproval: boolean;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectReason?: string;
  downloadCount: number;
  maxDownloads: number;
  /** 内存中 csv 字段可能为加密载荷 */
  encrypted?: boolean;
}

export interface CreateExportJobInput {
  tenantId: string;
  subjectId: string;
  requestId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  ttlMs?: number;
  /** 需要审批后才可下载；默认 false */
  requireApproval?: boolean;
  /** 默认 1（一次性下载） */
  maxDownloads?: number;
  /** 默认 true */
  watermark?: boolean;
}

export interface ExportJobStore {
  create(input: CreateExportJobInput): ExportJob;
  get(tenantId: string, subjectId: string, jobId: string): ExportJob | undefined;
  /** 同租户内查找（审批人用，不要求 job 归属本人） */
  getInTenant(tenantId: string, jobId: string): ExportJob | undefined;
  approve(
    tenantId: string,
    jobId: string,
    approverSubjectId: string,
  ): ExportJob;
  reject(
    tenantId: string,
    jobId: string,
    rejectorSubjectId: string,
    reason?: string,
  ): ExportJob;
  /** 一次性下载：达到 maxDownloads 后清除 csv */
  takeDownload(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): { csv: string; job: ExportJob };
  purgeExpired(): number;
  createAsync?(input: CreateExportJobInput): Promise<ExportJob>;
  getAsync?(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): Promise<ExportJob | undefined>;
  getInTenantAsync?(
    tenantId: string,
    jobId: string,
  ): Promise<ExportJob | undefined>;
  approveAsync?(
    tenantId: string,
    jobId: string,
    approverSubjectId: string,
  ): Promise<ExportJob>;
  rejectAsync?(
    tenantId: string,
    jobId: string,
    rejectorSubjectId: string,
    reason?: string,
  ): Promise<ExportJob>;
  takeDownloadAsync?(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): Promise<{ csv: string; job: ExportJob }>;
  purgeExpiredAsync?(): Promise<number>;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): void | Promise<void>;
}

export function publicExportJob(job: ExportJob): ExportJob {
  const { csv: _csv, ...safe } = job;
  return safe;
}

export class InMemoryExportJobStore implements ExportJobStore {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly encryptionSecret?: string;
  private readonly persistencePath?: string;

  constructor(
    encryptionSecretOrOptions?:
      | string
      | { encryptionSecret?: string; persistencePath?: string },
  ) {
    if (typeof encryptionSecretOrOptions === "string") {
      this.encryptionSecret = encryptionSecretOrOptions;
    } else {
      this.encryptionSecret = encryptionSecretOrOptions?.encryptionSecret;
      this.persistencePath = encryptionSecretOrOptions?.persistencePath;
    }
    this.load();
  }

  create(input: CreateExportJobInput): ExportJob {
    this.purgeExpired();
    const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
    const id = `exp-${randomUUID()}`;
    const now = Date.now();
    const requireApproval = Boolean(input.requireApproval);
    const maxDownloads = Math.max(1, input.maxDownloads ?? 1);
    const job: ExportJob = {
      id,
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      requestId: input.requestId,
      status: "running",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      requiresApproval: requireApproval,
      downloadCount: 0,
      maxDownloads,
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
      if (this.encryptionSecret) {
        job.csv = encryptExportPayload(csv, this.encryptionSecret);
        job.encrypted = true;
      } else {
        job.csv = csv;
      }
      job.rowCount = input.rows.length;
      job.status = requireApproval ? "pending_approval" : "completed";
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    }
    this.jobs.set(id, job);
    this.persist();
    return publicExportJob(job);
  }

  get(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): ExportJob | undefined {
    const job = this.refreshExpiry(this.jobs.get(jobId));
    if (!job) return undefined;
    if (job.tenantId !== tenantId || job.subjectId !== subjectId) {
      return undefined;
    }
    return publicExportJob(job);
  }

  getInTenant(tenantId: string, jobId: string): ExportJob | undefined {
    const job = this.refreshExpiry(this.jobs.get(jobId));
    if (!job || job.tenantId !== tenantId) return undefined;
    return publicExportJob(job);
  }

  approve(
    tenantId: string,
    jobId: string,
    approverSubjectId: string,
  ): ExportJob {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) {
      throw new Error("导出任务不存在");
    }
    this.refreshExpiry(job);
    if (job.status === "expired") {
      throw new Error("导出任务已过期");
    }
    if (job.status !== "pending_approval") {
      throw new Error(`当前状态不可审批: ${job.status}`);
    }
    if (job.subjectId === approverSubjectId) {
      throw new Error("Export owners cannot approve their own jobs");
    }
    job.status = "completed";
    job.approvedBy = approverSubjectId;
    job.approvedAt = new Date().toISOString();
    this.persist();
    return publicExportJob(job);
  }

  reject(
    tenantId: string,
    jobId: string,
    rejectorSubjectId: string,
    reason?: string,
  ): ExportJob {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) {
      throw new Error("导出任务不存在");
    }
    this.refreshExpiry(job);
    if (job.status === "expired") {
      throw new Error("导出任务已过期");
    }
    if (job.status !== "pending_approval") {
      throw new Error(`当前状态不可拒绝: ${job.status}`);
    }
    if (job.subjectId === rejectorSubjectId) {
      throw new Error("Export owners cannot reject their own jobs");
    }
    job.status = "rejected";
    job.rejectedBy = rejectorSubjectId;
    job.rejectedAt = new Date().toISOString();
    job.rejectReason = reason;
    job.csv = undefined;
    this.persist();
    return publicExportJob(job);
  }

  takeDownload(
    tenantId: string,
    subjectId: string,
    jobId: string,
  ): { csv: string; job: ExportJob } {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId || job.subjectId !== subjectId) {
      throw new Error("导出任务不存在");
    }
    this.refreshExpiry(job);
    if (job.status === "expired") {
      throw new Error("导出任务已过期");
    }
    if (job.status === "pending_approval") {
      throw new Error("导出任务待审批，暂不可下载");
    }
    if (job.status === "rejected") {
      throw new Error("导出任务已被拒绝");
    }
    if (job.requiresApproval && (!job.approvedBy || !job.approvedAt)) {
      throw new Error("Export approval is missing or invalid");
    }
    if (job.status !== "completed" || !job.csv) {
      throw new Error("导出文件不可用");
    }
    if (job.downloadCount >= job.maxDownloads) {
      job.status = "expired";
      job.csv = undefined;
      throw new Error("下载次数已用尽");
    }
    const stored = job.csv;
    const csv =
      job.encrypted && this.encryptionSecret
        ? decryptExportPayload(stored, this.encryptionSecret)
        : stored;
    job.downloadCount += 1;
    if (job.downloadCount >= job.maxDownloads) {
      job.csv = undefined;
      job.status = "expired";
    }
    this.persist();
    return { csv, job: publicExportJob(job) };
  }

  purgeExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.expiresAt) < now) {
        this.jobs.delete(id);
        n += 1;
      }
    }
    if (n > 0) this.persist();
    return n;
  }

  private load(): void {
    if (!this.persistencePath) return;
    try {
      const data = JSON.parse(
        fs.readFileSync(path.resolve(this.persistencePath), "utf8"),
      ) as { jobs?: ExportJob[] };
      for (const job of data.jobs ?? []) this.jobs.set(job.id, job);
    } catch {
      // Missing state starts an empty export queue.
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const absolute = path.resolve(this.persistencePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({ jobs: [...this.jobs.values()] }), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, absolute);
  }

  private refreshExpiry(job: ExportJob | undefined): ExportJob | undefined {
    if (!job) return undefined;
    if (Date.parse(job.expiresAt) < Date.now()) {
      job.status = "expired";
      job.csv = undefined;
    }
    return job;
  }
}

export async function createExportJobAsync(
  store: ExportJobStore,
  input: CreateExportJobInput,
): Promise<ExportJob> {
  return store.createAsync ? store.createAsync(input) : store.create(input);
}

export async function getExportJobAsync(
  store: ExportJobStore,
  tenantId: string,
  subjectId: string,
  jobId: string,
): Promise<ExportJob | undefined> {
  return store.getAsync
    ? store.getAsync(tenantId, subjectId, jobId)
    : store.get(tenantId, subjectId, jobId);
}

export async function approveExportJobAsync(
  store: ExportJobStore,
  tenantId: string,
  jobId: string,
  approverSubjectId: string,
): Promise<ExportJob> {
  return store.approveAsync
    ? store.approveAsync(tenantId, jobId, approverSubjectId)
    : store.approve(tenantId, jobId, approverSubjectId);
}

export async function rejectExportJobAsync(
  store: ExportJobStore,
  tenantId: string,
  jobId: string,
  rejectorSubjectId: string,
  reason?: string,
): Promise<ExportJob> {
  return store.rejectAsync
    ? store.rejectAsync(tenantId, jobId, rejectorSubjectId, reason)
    : store.reject(tenantId, jobId, rejectorSubjectId, reason);
}

export async function takeExportDownloadAsync(
  store: ExportJobStore,
  tenantId: string,
  subjectId: string,
  jobId: string,
): Promise<{ csv: string; job: ExportJob }> {
  return store.takeDownloadAsync
    ? store.takeDownloadAsync(tenantId, subjectId, jobId)
    : store.takeDownload(tenantId, subjectId, jobId);
}
