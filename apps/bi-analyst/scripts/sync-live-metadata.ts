#!/usr/bin/env tsx
/**
 * 扫描本机 Docker MySQL/PostgreSQL schema，并在显式批准后写入 Qdrant。
 *
 * 用法：
 *   pnpm sync:metadata:live -- --dry-run
 *   pnpm sync:metadata:live -- --approve
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dockerMysqlConnectionFromEnv,
  dockerPostgresConnectionFromEnv,
  scanMysqlSchemaLive,
  scanPostgresSchemaLive,
} from "../src/metadata/live-scanner.js";
import {
  createMetadataStack,
  resolveMetadataAlias,
} from "../src/metadata/metadata-factory.js";
import { summarizeEmbeddingConfig } from "../src/metadata/embedding-factory.js";
import type { SchemaDocument } from "../src/metadata/types.js";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const approve = args.has("--approve");
const mysqlOnly = args.has("--mysql-only");
const postgresOnly = args.has("--pg-only");
const DEFAULT_LIVE_METADATA_TABLES = ["users", "orders"];

function requestedTables(): string[] | undefined {
  const raw = process.env.BI_LIVE_METADATA_TABLES?.trim();
  if (!raw) return DEFAULT_LIVE_METADATA_TABLES;
  const tables = raw.split(",").map((table) => table.trim()).filter(Boolean);
  return tables.length > 0 ? tables : undefined;
}

async function scanLiveDocuments(): Promise<SchemaDocument[]> {
  const tables = requestedTables();
  const documents: SchemaDocument[] = [];

  if (!postgresOnly) {
    const mysql = await scanMysqlSchemaLive(dockerMysqlConnectionFromEnv(), {
      datasourceId: process.env.BI_MYSQL_DATASOURCE_ID ?? "sales_mysql",
      domain: process.env.BI_MYSQL_DOMAIN ?? "retail",
      tables,
      reviewStatus: approve ? "approved" : "draft",
    });
    documents.push(...mysql);
    console.info(JSON.stringify({ datasource: "mysql", scanned: mysql.length }));
  }

  if (!mysqlOnly) {
    const postgres = await scanPostgresSchemaLive(dockerPostgresConnectionFromEnv(), {
      datasourceId: process.env.BI_PG_DATASOURCE_ID ?? "analytics_pg",
      domain: process.env.BI_PG_DOMAIN ?? "retail",
      tables,
      reviewStatus: approve ? "approved" : "draft",
    });
    documents.push(...postgres);
    console.info(JSON.stringify({ datasource: "postgresql", scanned: postgres.length }));
  }

  return documents;
}

async function main(): Promise<void> {
  if (!dryRun && !approve) {
    throw new Error(
      "live schema 默认保持 draft；预览使用 --dry-run，写入 approved 文档必须显式传 --approve",
    );
  }

  const documents = await scanLiveDocuments();
  const liveDocuments = documents.filter(
    (doc) => doc.datasourceId !== "ecommerce_sqlite",
  );
  const approvedCount = liveDocuments.filter(
    (doc) => doc.reviewStatus === "approved",
  ).length;

  console.info(
    JSON.stringify({
      action: dryRun ? "dry-run" : "rebuild",
      approval: approve ? "explicit-approve" : "draft-preview",
      alias: resolveMetadataAlias(),
      totalDocuments: documents.length,
      liveDocuments: liveDocuments.length,
      approvedLiveDocuments: approvedCount,
      embedding: summarizeEmbeddingConfig(),
    }),
  );

  if (dryRun) return;

  if (!process.env.QDRANT_URL?.trim()) {
    throw new Error("写入 live metadata 需要 QDRANT_URL");
  }

  const { indexer } = createMetadataStack();
  const result = await indexer.rebuildWithAliasSwap(documents);
  console.info(
    JSON.stringify({
      status: "ok",
      alias: result.alias,
      newCollection: result.newCollection,
      previousCollection: result.previousCollection,
      indexedCount: result.indexedCount,
      approvedLiveDocuments: approvedCount,
    }),
  );
}

main().catch((error) => {
  console.error("sync:metadata:live 失败:", error);
  process.exit(1);
});
