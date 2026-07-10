#!/usr/bin/env tsx
/**
 * 将附录 A demo 元数据索引到 Qdrant（或本地内存后端，用于调试）。
 *
 * 用法：
 *   QDRANT_URL=http://127.0.0.1:6333 pnpm index:metadata
 *   pnpm index:metadata -- --dry-run
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SCHEMA_DOCUMENTS } from "../src/metadata/demo-documents.js";
import {
  createMetadataStack,
  resolveMetadataAlias,
} from "../src/metadata/metadata-factory.js";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const qdrantUrl = process.env.QDRANT_URL;
  const alias = resolveMetadataAlias();

  if (!qdrantUrl && !dryRun) {
    console.error(
      "index:metadata 需要 QDRANT_URL。示例: QDRANT_URL=http://127.0.0.1:6333 pnpm index:metadata",
    );
    process.exit(1);
  }

  console.info(
    JSON.stringify({
      action: dryRun ? "dry-run" : "index",
      qdrantUrl: qdrantUrl ?? "(dry-run)",
      alias,
      documentCount: DEMO_SCHEMA_DOCUMENTS.length,
      embedding: (await import("../src/metadata/embedding-factory.js"))
        .summarizeEmbeddingConfig(),
    }),
  );

  if (dryRun) {
    for (const doc of DEMO_SCHEMA_DOCUMENTS) {
      console.info(`  - ${doc.id} (${doc.docType})`);
    }
    return;
  }

  const { indexer } = createMetadataStack();
  const result = await indexer.rebuildWithAliasSwap(DEMO_SCHEMA_DOCUMENTS);

  console.info(
    JSON.stringify({
      status: "ok",
      alias: result.alias,
      newCollection: result.newCollection,
      previousCollection: result.previousCollection,
      indexedCount: result.indexedCount,
    }),
  );
}

main().catch((err) => {
  console.error("index:metadata 失败:", err);
  process.exit(1);
});
