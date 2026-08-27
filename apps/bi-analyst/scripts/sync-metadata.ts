#!/usr/bin/env tsx
/**
 * 元数据扫描 → 增量/全量同步编排（Phase F cron 入口）。
 *
 * 用法：
 *   pnpm sync:metadata                    # 扫描本地 SQLite + 内存索引
 *   pnpm sync:metadata -- --rebuild       # 强制 alias rebuild
 *   QDRANT_URL=... pnpm sync:metadata     # 写入 Qdrant 集群
 *   pnpm sync:metadata -- --dry-run       # 仅扫描输出文档数
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/db/seed.js";
import { scanSqliteSchema } from "../src/metadata/scanner.js";
import { runMetadataSync } from "../src/metadata/sync-runner.js";
import {
  createMetadataStack,
  resolveMetadataAlias,
} from "../src/metadata/metadata-factory.js";
import { DEMO_SCHEMA_DOCUMENTS } from "../src/metadata/demo-documents.js";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const forceRebuild = process.argv.includes("--rebuild");
  const useDemo = process.argv.includes("--demo");
  const dbPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../data/ecommerce.db",
  );

  const db = createDatabase(dbPath);
  try {
    const scanned = useDemo
      ? DEMO_SCHEMA_DOCUMENTS
      : scanSqliteSchema(db, {
          datasourceId: "ecommerce_sqlite",
          domain: "retail",
          dialectFamily: "sqlite",
        });

    console.info(
      JSON.stringify({
        action: dryRun ? "dry-run" : "sync",
        alias: resolveMetadataAlias(),
        documentCount: scanned.length,
        mode: forceRebuild ? "rebuild" : "incremental",
        source: useDemo ? "demo-documents" : "sqlite-scan",
      }),
    );

    if (dryRun) {
      for (const doc of scanned.slice(0, 10)) {
        console.info(`  - ${doc.id} (${doc.docType})`);
      }
      if (scanned.length > 10) {
        console.info(`  ... +${scanned.length - 10} more`);
      }
      return;
    }

    const { indexer } = createMetadataStack();
    const previousTarget = await indexer.getAliasTarget();
    const previous = await indexer.readCurrentDocuments();

    const result = await runMetadataSync({
      indexer,
      nextDocuments: scanned,
      previousDocuments: previous,
      mode: forceRebuild ? "rebuild" : "incremental",
      shardByTable: true,
    });

    console.info(
      JSON.stringify({
        status: "ok",
        mode: result.mode,
        upserted: result.upserted,
        tombstoned: result.tombstoned,
        collection: result.collection,
        previousTarget,
        alias: result.aliasSwap?.alias,
        newCollection: result.aliasSwap?.newCollection,
        schemaVersion: indexer.getSchemaVersion(),
        summary: {
          added: result.diff.added.length,
          changed: result.diff.changed.length,
          removed: result.diff.removed.length,
        },
      }),
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("sync:metadata 失败:", err);
  process.exit(1);
});
