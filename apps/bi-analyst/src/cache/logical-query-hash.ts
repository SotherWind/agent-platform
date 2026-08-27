import { createHash } from "node:crypto";
import type { LogicalQuery } from "../query-plan/logical-query.js";

/**
 * 稳定序列化 LogicalQuery → SHA256 hex（前 32 位）。
 * 字段排序保证同语义同 hash，与 query 文本解耦。
 */
export function hashLogicalQuery(query: LogicalQuery): string {
  const canonical = canonicalize(query);
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalize(v);
  }
  return out;
}
