import { createHash } from "node:crypto";
import type { SchemaDocument } from "./types.js";
import { computeContentHash } from "./index-utils.js";

export type SchemaChangeKind = "added" | "changed" | "removed" | "unchanged";

export interface SchemaChange {
  id: string;
  kind: SchemaChangeKind;
  previousHash?: string;
  nextHash?: string;
}

export interface SchemaDiffResult {
  added: SchemaDocument[];
  changed: SchemaDocument[];
  removed: SchemaDocument[];
  unchanged: SchemaDocument[];
  changes: SchemaChange[];
}

function docHash(doc: SchemaDocument): string {
  return (
    doc.contentHash ??
    computeContentHash(
      [
        doc.id,
        doc.docType,
        doc.content,
        doc.table ?? "",
        doc.column ?? "",
        doc.reviewStatus ?? "",
        doc.deleted ? "1" : "0",
      ].join("|"),
    )
  );
}

/** 对比前后 schema 快照，检测增量变更（不自动 upsert） */
export function diffSchemaDocuments(
  previous: SchemaDocument[],
  next: SchemaDocument[],
): SchemaDiffResult {
  const prevMap = new Map(previous.map((d) => [d.id, d]));
  const nextMap = new Map(next.map((d) => [d.id, d]));

  const added: SchemaDocument[] = [];
  const changed: SchemaDocument[] = [];
  const removed: SchemaDocument[] = [];
  const unchanged: SchemaDocument[] = [];
  const changes: SchemaChange[] = [];

  for (const [id, doc] of nextMap) {
    const old = prevMap.get(id);
    if (!old) {
      added.push(doc);
      changes.push({ id, kind: "added", nextHash: docHash(doc) });
      continue;
    }
    const prevH = docHash(old);
    const nextH = docHash(doc);
    if (prevH !== nextH) {
      changed.push(doc);
      changes.push({
        id,
        kind: "changed",
        previousHash: prevH,
        nextHash: nextH,
      });
    } else {
      unchanged.push(doc);
      changes.push({
        id,
        kind: "unchanged",
        previousHash: prevH,
        nextHash: nextH,
      });
    }
  }

  for (const [id, doc] of prevMap) {
    if (!nextMap.has(id)) {
      removed.push(doc);
      changes.push({ id, kind: "removed", previousHash: docHash(doc) });
    }
  }

  return { added, changed, removed, unchanged, changes };
}

export interface IncrementalSyncPlan {
  toUpsert: SchemaDocument[];
  toTombstone: string[];
  summary: {
    added: number;
    changed: number;
    removed: number;
    unchanged: number;
  };
}

/** 由 diff 结果生成增量同步计划（upsert 新增/变更，tombstone 删除） */
export function planIncrementalSync(diff: SchemaDiffResult): IncrementalSyncPlan {
  return {
    toUpsert: [...diff.added, ...diff.changed],
    toTombstone: diff.removed.map((d) => d.id),
    summary: {
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      unchanged: diff.unchanged.length,
    },
  };
}

/** 内容指纹：用于扫描批次去重 */
export function fingerprintDocumentSet(docs: SchemaDocument[]): string {
  const parts = docs
    .map((d) => `${d.id}:${docHash(d)}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(parts, "utf8").digest("hex").slice(0, 24);
}
