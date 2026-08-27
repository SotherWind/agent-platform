import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  decryptExportPayload,
  encryptExportPayload,
} from "../export/encrypt.js";

export type FeedbackRating = "positive" | "negative";

export interface AnalysisFeedback {
  id: string;
  tenantId: string;
  subjectId: string;
  requestId: string;
  traceId?: string;
  query: string;
  rating: FeedbackRating;
  categories: string[];
  comment?: string;
  correctedSql?: string;
  expectedAnswer?: string;
  modelVersionId?: string;
  createdAt: string;
}

export interface CreateAnalysisFeedbackInput {
  tenantId: string;
  subjectId: string;
  requestId: string;
  traceId?: string;
  query: string;
  rating: FeedbackRating;
  categories?: string[];
  comment?: string;
  correctedSql?: string;
  expectedAnswer?: string;
  modelVersionId?: string;
}

export interface FeedbackListOptions {
  limit?: number;
  offset?: number;
  rating?: FeedbackRating;
  requestId?: string;
  includePositive?: boolean;
}

export interface AnalysisFeedbackStore {
  create(input: CreateAnalysisFeedbackInput): AnalysisFeedback;
  get(tenantId: string, subjectId: string, id: string): AnalysisFeedback | undefined;
  list(
    tenantId: string,
    subjectId: string,
    options?: FeedbackListOptions,
  ): AnalysisFeedback[];
  listInTenant(tenantId: string, options?: FeedbackListOptions): AnalysisFeedback[];
  createAsync?(input: CreateAnalysisFeedbackInput): Promise<AnalysisFeedback>;
  getAsync?(tenantId: string, subjectId: string, id: string): Promise<AnalysisFeedback | undefined>;
  listAsync?(
    tenantId: string,
    subjectId: string,
    options?: FeedbackListOptions,
  ): Promise<AnalysisFeedback[]>;
  listInTenantAsync?(tenantId: string, options?: FeedbackListOptions): Promise<AnalysisFeedback[]>;
  purgeOlderThan?(retentionMs: number, now?: Date): number;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): void | Promise<void>;
}

function normalizeOptions(options?: FeedbackListOptions): Required<Pick<FeedbackListOptions, "limit" | "offset">> &
  Pick<FeedbackListOptions, "rating" | "requestId" | "includePositive"> {
  return {
    limit: Math.min(Math.max(1, options?.limit ?? 50), 200),
    offset: Math.max(0, options?.offset ?? 0),
    rating: options?.rating,
    requestId: options?.requestId,
    includePositive: options?.includePositive ?? true,
  };
}

function clone(value: AnalysisFeedback): AnalysisFeedback {
  return { ...value, categories: [...value.categories] };
}

function filterRecords(
  records: Iterable<AnalysisFeedback>,
  options?: FeedbackListOptions,
): AnalysisFeedback[] {
  const normalized = normalizeOptions(options);
  return [...records]
    .filter((record) => normalized.includePositive || record.rating === "negative")
    .filter((record) => !normalized.rating || record.rating === normalized.rating)
    .filter((record) => !normalized.requestId || record.requestId === normalized.requestId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(normalized.offset, normalized.offset + normalized.limit)
    .map(clone);
}

export class InMemoryAnalysisFeedbackStore implements AnalysisFeedbackStore {
  protected readonly records = new Map<string, AnalysisFeedback>();

  create(input: CreateAnalysisFeedbackInput): AnalysisFeedback {
    const query = input.query.trim();
    if (!query) throw new Error("Feedback query must not be empty");
    if (input.rating === "negative" && !input.comment?.trim() && !input.correctedSql?.trim()) {
      throw new Error("Negative feedback requires a comment or corrected SQL");
    }
    const record: AnalysisFeedback = {
      id: `fb-${randomUUID()}`,
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      requestId: input.requestId,
      traceId: input.traceId,
      query,
      rating: input.rating,
      categories: [...new Set((input.categories ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 12),
      comment: input.comment?.trim() || undefined,
      correctedSql: input.correctedSql?.trim() || undefined,
      expectedAnswer: input.expectedAnswer?.trim() || undefined,
      modelVersionId: input.modelVersionId?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.id, record);
    return clone(record);
  }

  get(tenantId: string, subjectId: string, id: string): AnalysisFeedback | undefined {
    const record = this.records.get(id);
    if (!record || record.tenantId !== tenantId || record.subjectId !== subjectId) return undefined;
    return clone(record);
  }

  list(tenantId: string, subjectId: string, options?: FeedbackListOptions): AnalysisFeedback[] {
    return filterRecords(
      [...this.records.values()].filter(
        (record) => record.tenantId === tenantId && record.subjectId === subjectId,
      ),
      options,
    );
  }

  listInTenant(tenantId: string, options?: FeedbackListOptions): AnalysisFeedback[] {
    return filterRecords(
      [...this.records.values()].filter((record) => record.tenantId === tenantId),
      options,
    );
  }

  purgeOlderThan(retentionMs: number, now = new Date()): number {
    const cutoff = now.getTime() - Math.max(0, retentionMs);
    let removed = 0;
    for (const [id, record] of this.records) {
      if (Date.parse(record.createdAt) < cutoff) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Atomic JSON persistence for single-machine staging deployments. */
export class PersistentAnalysisFeedbackStore extends InMemoryAnalysisFeedbackStore {
  constructor(
    private readonly filePath: string,
    private readonly encryptionSecret?: string,
  ) {
    super();
    this.load();
  }

  override create(input: CreateAnalysisFeedbackInput): AnalysisFeedback {
    const saved = super.create(input);
    this.save();
    return saved;
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
        records?: AnalysisFeedback[];
      };
      const raw = outer.encrypted
        ? this.encryptionSecret
          ? (JSON.parse(decryptExportPayload(outer.encrypted, this.encryptionSecret)) as {
              records?: AnalysisFeedback[];
            })
          : (() => {
              throw new Error("Encrypted feedback state requires ANALYSIS_STATE_ENCRYPTION_SECRET");
            })()
        : outer;
      if (!Array.isArray(raw.records)) {
        throw new Error("Analysis feedback state is missing a records array");
      }
      for (const record of raw.records) {
        if (record?.id && record.tenantId && record.subjectId && record.requestId) {
          this.records.set(record.id, {
            ...record,
            categories: Array.isArray(record.categories) ? record.categories.map(String) : [],
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw new Error(
        `Unable to load analysis feedback state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private save(): void {
    const absolute = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}`;
    const plain = JSON.stringify({ records: [...this.records.values()] });
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

export async function createFeedbackAsync(
  store: AnalysisFeedbackStore,
  input: CreateAnalysisFeedbackInput,
): Promise<AnalysisFeedback> {
  return store.createAsync ? store.createAsync(input) : store.create(input);
}

export async function listFeedbackAsync(
  store: AnalysisFeedbackStore,
  tenantId: string,
  subjectId: string,
  options?: FeedbackListOptions,
): Promise<AnalysisFeedback[]> {
  return store.listAsync
    ? store.listAsync(tenantId, subjectId, options)
    : store.list(tenantId, subjectId, options);
}

export async function listTenantFeedbackAsync(
  store: AnalysisFeedbackStore,
  tenantId: string,
  options?: FeedbackListOptions,
): Promise<AnalysisFeedback[]> {
  return store.listInTenantAsync
    ? store.listInTenantAsync(tenantId, options)
    : store.listInTenant(tenantId, options);
}
