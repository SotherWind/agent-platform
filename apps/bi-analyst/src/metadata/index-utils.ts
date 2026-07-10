import { createHash } from "node:crypto";
import type { SchemaDocument } from "./types.js";

export const DEFAULT_EMBEDDING_MODEL_VERSION = "deterministic-v1";
export const DEFAULT_SCHEMA_VERSION = "1";

export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export function enrichDocumentForIndex(
  doc: SchemaDocument,
  schemaVersion: string,
  embeddingModelVersion = DEFAULT_EMBEDDING_MODEL_VERSION,
): SchemaDocument {
  const indexedAt = new Date().toISOString();
  const contentHash = computeContentHash(doc.content);
  return {
    ...doc,
    schemaVersion,
    indexedAt,
    contentHash,
    sourceUpdatedAt: doc.sourceUpdatedAt ?? indexedAt,
    embeddingModelVersion,
  };
}

export function documentToPayload(doc: SchemaDocument): Record<string, unknown> {
  return {
    id: doc.id,
    docType: doc.docType,
    datasourceId: doc.datasourceId,
    domain: doc.domain,
    dialectFamily: doc.dialectFamily,
    schema: doc.schema,
    table: doc.table,
    column: doc.column,
    tags: doc.tags,
    sensitivity: doc.sensitivity,
    fieldRole: doc.fieldRole,
    schemaVersion: doc.schemaVersion,
    indexedAt: doc.indexedAt,
    sourceUpdatedAt: doc.sourceUpdatedAt,
    contentHash: doc.contentHash,
    embeddingModelVersion: doc.embeddingModelVersion,
    reviewStatus: doc.reviewStatus,
    deleted: doc.deleted ?? false,
    content: doc.content,
  };
}

export function payloadToDocument(
  payload: Record<string, unknown>,
): SchemaDocument {
  return {
    id: String(payload.id),
    docType: payload.docType as SchemaDocument["docType"],
    content: String(payload.content ?? ""),
    datasourceId: String(payload.datasourceId),
    domain: String(payload.domain),
    dialectFamily: payload.dialectFamily as SchemaDocument["dialectFamily"],
    schema: payload.schema as string | undefined,
    table: payload.table as string | undefined,
    column: payload.column as string | undefined,
    tags: payload.tags as string[] | undefined,
    sensitivity: payload.sensitivity as SchemaDocument["sensitivity"],
    fieldRole: payload.fieldRole as SchemaDocument["fieldRole"],
    schemaVersion: payload.schemaVersion as string | undefined,
    indexedAt: payload.indexedAt as string | undefined,
    sourceUpdatedAt: payload.sourceUpdatedAt as string | undefined,
    contentHash: payload.contentHash as string | undefined,
    embeddingModelVersion: payload.embeddingModelVersion as string | undefined,
    reviewStatus: payload.reviewStatus as SchemaDocument["reviewStatus"],
    deleted: Boolean(payload.deleted),
  };
}

export function markTombstone(doc: SchemaDocument): SchemaDocument {
  return {
    ...doc,
    deleted: true,
    indexedAt: new Date().toISOString(),
  };
}
