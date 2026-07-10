import { createHash } from "node:crypto";

/** 将业务 doc.id 映射为 Qdrant 可接受的 UUID 形态 point id */
export function toStablePointId(docId: string): string {
  const hash = createHash("sha256").update(docId, "utf8").digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
