import type { ReviewStatus, SchemaDocument } from "./types.js";

export interface ReviewDecision {
  documentId: string;
  status: Extract<ReviewStatus, "approved" | "rejected">;
  reviewedBy: string;
  reviewedAt: string;
  note?: string;
}

export interface MetadataReviewStore {
  upsertDraft(doc: SchemaDocument): SchemaDocument;
  list(filter?: {
    status?: ReviewStatus;
    datasourceId?: string;
    limit?: number;
  }): SchemaDocument[];
  get(documentId: string): SchemaDocument | undefined;
  decide(
    documentId: string,
    decision: Omit<ReviewDecision, "documentId" | "reviewedAt"> & {
      note?: string;
    },
  ): SchemaDocument;
  upsertDraftAsync?(doc: SchemaDocument): Promise<SchemaDocument>;
  listAsync?(filter?: {
    status?: ReviewStatus;
    datasourceId?: string;
    limit?: number;
  }): Promise<SchemaDocument[]>;
  getAsync?(documentId: string): Promise<SchemaDocument | undefined>;
  decideAsync?(
    documentId: string,
    decision: Omit<ReviewDecision, "documentId" | "reviewedAt"> & {
      note?: string;
    },
  ): Promise<SchemaDocument>;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): void | Promise<void>;
}

/** 内存审核队列：draft/pending → approved/rejected；禁止自动 certification */
export class InMemoryMetadataReviewStore implements MetadataReviewStore {
  private readonly docs = new Map<string, SchemaDocument>();
  private readonly decisions: ReviewDecision[] = [];

  upsertDraft(doc: SchemaDocument): SchemaDocument {
    if (doc.tags?.includes("certified")) {
      throw new Error("禁止通过审核流写入 certified 标签；请走 MetricRegistry 正式认证");
    }
    const saved: SchemaDocument = {
      ...doc,
      reviewStatus: doc.reviewStatus ?? "draft",
    };
    this.docs.set(saved.id, saved);
    return { ...saved };
  }

  list(filter?: {
    status?: ReviewStatus;
    datasourceId?: string;
    limit?: number;
  }): SchemaDocument[] {
    const limit = Math.min(Math.max(1, filter?.limit ?? 50), 200);
    return [...this.docs.values()]
      .filter((d) => !filter?.status || d.reviewStatus === filter.status)
      .filter(
        (d) => !filter?.datasourceId || d.datasourceId === filter.datasourceId,
      )
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  get(documentId: string): SchemaDocument | undefined {
    const doc = this.docs.get(documentId);
    return doc ? { ...doc } : undefined;
  }

  decide(
    documentId: string,
    decision: Omit<ReviewDecision, "documentId" | "reviewedAt"> & {
      note?: string;
    },
  ): SchemaDocument {
    const doc = this.docs.get(documentId);
    if (!doc) {
      throw new Error(`文档不存在: ${documentId}`);
    }
    // reviewStatus=approved 仅表示描述已审；指标口径 certification 仍须走 MetricRegistry
    if (doc.tags?.includes("certified")) {
      throw new Error("禁止在审核流中写入 certified 标签");
    }
    const updated: SchemaDocument = {
      ...doc,
      reviewStatus: decision.status,
    };
    this.docs.set(documentId, updated);
    this.decisions.push({
      documentId,
      status: decision.status,
      reviewedBy: decision.reviewedBy,
      reviewedAt: new Date().toISOString(),
      note: decision.note,
    });
    return { ...updated };
  }

  listDecisions(): ReviewDecision[] {
    return [...this.decisions];
  }
}

/** File-backed review queue for single-node staging/production deployments. */
export class PersistentMetadataReviewStore implements MetadataReviewStore {
  private readonly inner = new InMemoryMetadataReviewStore();

  constructor(private readonly filePath: string) {
    this.load();
  }

  upsertDraft(doc: SchemaDocument): SchemaDocument {
    const saved = this.inner.upsertDraft(doc);
    this.save();
    return saved;
  }

  list(filter?: Parameters<MetadataReviewStore["list"]>[0]): SchemaDocument[] {
    return this.inner.list(filter);
  }

  get(documentId: string): SchemaDocument | undefined {
    return this.inner.get(documentId);
  }

  decide(
    documentId: string,
    decision: Parameters<MetadataReviewStore["decide"]>[1],
  ): SchemaDocument {
    const saved = this.inner.decide(documentId, decision);
    this.save();
    return saved;
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(path.resolve(this.filePath), "utf8")) as {
        documents?: SchemaDocument[];
      };
      for (const document of data.documents ?? []) {
        this.inner.upsertDraft(document);
      }
    } catch {
      // Missing state is an empty review queue.
    }
  }

  private save(): void {
    const absolute = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const documents = [
      ...this.inner.list({ status: "draft", limit: 200 }),
      ...this.inner.list({ status: "pending", limit: 200 }),
      ...this.inner.list({ status: "approved", limit: 200 }),
      ...this.inner.list({ status: "rejected", limit: 200 }),
    ];
    const temp = `${absolute}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({ documents }), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, absolute);
  }
}
import fs from "node:fs";
import path from "node:path";

export async function listMetadataReviewsAsync(
  store: MetadataReviewStore,
  filter?: Parameters<MetadataReviewStore["list"]>[0],
): Promise<SchemaDocument[]> {
  return store.listAsync ? store.listAsync(filter) : store.list(filter);
}

export async function upsertMetadataDraftAsync(
  store: MetadataReviewStore,
  document: SchemaDocument,
): Promise<SchemaDocument> {
  return store.upsertDraftAsync
    ? store.upsertDraftAsync(document)
    : store.upsertDraft(document);
}

export async function decideMetadataReviewAsync(
  store: MetadataReviewStore,
  documentId: string,
  decision: Parameters<MetadataReviewStore["decide"]>[1],
): Promise<SchemaDocument> {
  return store.decideAsync
    ? store.decideAsync(documentId, decision)
    : store.decide(documentId, decision);
}
