import { computeContentHash } from "./index-utils.js";
import type { SchemaDocument } from "./types.js";

export type SchemaChangeKind = "added" | "changed" | "removed" | "unchanged";

export interface SchemaDocChange {
  id: string;
  kind: SchemaChangeKind;
  previousHash?: string;
  nextHash?: string;
}

export interface SchemaSyncDiff {
  added: SchemaDocument[];
  changed: SchemaDocument[];
  removed: SchemaDocument[];
  unchanged: SchemaDocument[];
  changes: SchemaDocChange[];
}

function docHash(doc: SchemaDocument): string {
  return doc.contentHash ?? computeContentHash(doc.content);
}

/** 对比新旧文档集，产出增量同步差异（基于 id + contentHash） */
export function diffSchemaDocuments(
  previous: SchemaDocument[],
  next: SchemaDocument[],
): SchemaSyncDiff {
  const prevMap = new Map(previous.map((d) => [d.id, d]));
  const nextMap = new Map(next.map((d) => [d.id, d]));

  const added: SchemaDocument[] = [];
  const changed: SchemaDocument[] = [];
  const removed: SchemaDocument[] = [];
  const unchanged: SchemaDocument[] = [];
  const changes: SchemaDocChange[] = [];

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
      changes.push({ id, kind: "unchanged", previousHash: prevH, nextHash: nextH });
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
  upsert: SchemaDocument[];
  tombstoneIds: string[];
  skipped: number;
}

/** 将 diff 转为增量计划：upsert = added+changed；tombstone = removed */
export function planIncrementalSync(diff: SchemaSyncDiff): IncrementalSyncPlan {
  return {
    upsert: [...diff.added, ...diff.changed],
    tombstoneIds: diff.removed.map((d) => d.id),
    skipped: diff.unchanged.length,
  };
}
