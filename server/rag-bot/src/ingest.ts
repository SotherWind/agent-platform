/**
 * 知识库自动灌库：启动时检测 Qdrant collection 是否为空，
 * 为空则把 KNOWLEDGE_DIR 下的 .md 文档 ingest 到每个已知租户名下。
 *
 * 降级策略（与拷问定稿一致）：
 * - 未配置 Qdrant（无 QDRANT_URL/QDRANT_API_KEY）→ 跳过并提示（检索为空，图仍可直答）
 * - Qdrant 不可达 → 仅告警不崩溃（对话功能不因知识库问题整体下线）
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { VectorStoreType } from "@agent-platform/rag-boot";
import type { ServerConfig } from "./config.js";

function tenantList(config: ServerConfig): string[] {
  const tenants = new Set<string>();
  for (const user of config.users) tenants.add(user.tenantId);
  for (const token of config.systemTokens) tenants.add(token.tenantId);
  return [...tenants];
}

async function isCollectionEmpty(collectionName: string): Promise<boolean> {
  const client = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY || undefined,
  });
  try {
    const { count } = await client.count(collectionName);
    return count === 0;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 404) return true;
    throw error;
  }
}

export async function autoIngestKnowledge(
  config: ServerConfig,
  store: VectorStoreType,
): Promise<void> {
  if (!config.autoIngest) {
    console.log("[ingest] AUTO_INGEST=false，跳过自动灌库");
    return;
  }
  if (!process.env.QDRANT_URL && !process.env.QDRANT_API_KEY) {
    console.log("[ingest] 未配置 Qdrant，跳过自动灌库（检索将为空，属安全降级）");
    return;
  }

  const tenants = tenantList(config);
  if (tenants.length === 0) {
    console.log("[ingest] 未配置任何账号/系统 token，无从确定租户，跳过自动灌库");
    return;
  }

  const collectionName = process.env.QDRANT_COLLECTION_NAME ?? "rag_boot";
  const dir = resolve(config.knowledgeDir);

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  } catch {
    console.warn(`[ingest] 知识目录不存在或不可读: ${dir}，跳过自动灌库`);
    return;
  }
  if (files.length === 0) {
    console.warn(`[ingest] 知识目录没有 .md 文档: ${dir}，跳过自动灌库`);
    return;
  }

  let empty: boolean;
  try {
    empty = await isCollectionEmpty(collectionName);
  } catch (error) {
    console.warn(`[ingest] Qdrant 不可达，跳过自动灌库（不影响对话）: ${String(error)}`);
    return;
  }
  if (!empty) {
    console.log(`[ingest] collection "${collectionName}" 已有数据，跳过自动灌库`);
    return;
  }

  // Reuse the reader's store and publication manifest; a separate manifest would hide new data.
  let total = 0;
  for (const tenantId of tenants) {
    for (const file of files) {
      const documentId = file.replace(/\.md$/i, "");
      try {
        const count = await store.ingestFile(join(dir, file), {
          tenantId,
          documentId,
          source: file,
        });
        total += count;
      } catch (error) {
        console.warn(`[ingest] ${file} → ${tenantId} 失败: ${String(error)}`);
      }
    }
  }
  console.log(`[ingest] 自动灌库完成：${files.length} 篇文档 × ${tenants.length} 个租户，共 ${total} 个 chunk`);
}
