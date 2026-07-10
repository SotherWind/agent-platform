import type { SchemaDocument } from "./types.js";

export type FreshnessStatus = "fresh" | "stale" | "unknown";

export interface DataFreshnessMeta {
  dataAsOf: string;
  timezone: string;
  status: FreshnessStatus;
  warnings: string[];
}

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 从检索到的元数据文档推导数据新鲜度 */
export function computeMetadataFreshness(
  documents: SchemaDocument[],
  options?: {
    timezone?: string;
    staleAfterMs?: number;
    now?: Date;
  },
): DataFreshnessMeta {
  const timezone = options?.timezone ?? DEFAULT_TIMEZONE;
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options?.now ?? new Date();
  const warnings: string[] = [];

  if (documents.length === 0) {
    return {
      dataAsOf: now.toISOString(),
      timezone,
      status: "unknown",
      warnings: ["未检索到元数据文档，无法确认数据新鲜度"],
    };
  }

  let latestMs: number | null = null;
  let missingTimestampCount = 0;
  const schemaVersions = new Set<string>();

  for (const doc of documents) {
    const ts =
      parseTimestamp(doc.sourceUpdatedAt) ?? parseTimestamp(doc.indexedAt);
    if (ts === null) {
      missingTimestampCount += 1;
    } else if (latestMs === null || ts > latestMs) {
      latestMs = ts;
    }
    if (doc.schemaVersion) schemaVersions.add(doc.schemaVersion);
  }

  if (missingTimestampCount > 0) {
    warnings.push(`${missingTimestampCount} 条元数据缺少 sourceUpdatedAt/indexedAt`);
  }
  if (schemaVersions.size > 1) {
    warnings.push(
      `检索结果包含多个 schemaVersion: ${[...schemaVersions].join(", ")}`,
    );
  }
  if (documents.some((d) => d.deleted)) {
    warnings.push("检索结果包含已标记删除的文档");
  }

  const dataAsOf =
    latestMs !== null ? new Date(latestMs).toISOString() : now.toISOString();

  if (latestMs === null) {
    return { dataAsOf, timezone, status: "unknown", warnings };
  }

  const ageMs = now.getTime() - latestMs;
  const status: FreshnessStatus =
    ageMs > staleAfterMs ? "stale" : "fresh";

  if (status === "stale") {
    warnings.push(
      `元数据已超过 ${Math.round(staleAfterMs / 3_600_000)} 小时未更新`,
    );
  }

  return { dataAsOf, timezone, status, warnings };
}
