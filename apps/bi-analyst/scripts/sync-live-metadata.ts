#!/usr/bin/env tsx
/**
 * 扫描本机 Docker MySQL/PostgreSQL schema，并在显式批准后写入 Qdrant。
 *
 * 用法：
 *   pnpm sync:metadata:live -- --dry-run
 *   pnpm sync:metadata:live -- --approve
 *
 * ── 关于 --include-demo（本地开发例外，请勿在生产使用）────────────────────
 * 安全清单 P2-07 的要求是「live rebuild **不自动**混入 demo schema」，验收标准是
 * 「生产索引不出现 demo datasource」（见 docs/BI-ANALYST-SECURITY-REMEDIATION-CHECKLIST.md）。
 * 本开关把 `DEMO_SCHEMA_DOCUMENTS`（13 条，全部为 ecommerce_sqlite）一并写入，
 * 目的是让本地开发环境的索引保持「live 24 条 + demo 13 条 = 37 条」的既有状态。
 *
 * 它之所以不违反 P2-07 的**字面**要求，是因为**不传这个开关就绝不会混入**（不是自动行为），
 * 但它确实偏离了「生产索引不出现 demo datasource」这条**验收标准**——
 * 所以在生产环境使用它等于主动引入一个已知不合规项。传了会在输出里打 `demoIncluded: true`。
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
import { DEMO_SCHEMA_DOCUMENTS } from "../src/metadata/demo-documents.js";
import type { SchemaDocument } from "../src/metadata/types.js";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const approve = args.has("--approve");
const mysqlOnly = args.has("--mysql-only");
const postgresOnly = args.has("--pg-only");
/** 显式请求才混入 demo 文档；见文件头说明与 P2-07 */
const includeDemo = args.has("--include-demo");
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

  if (includeDemo) {
    // 显式混入：见文件头「关于 --include-demo」。DEMO_SCHEMA_DOCUMENTS 自带 reviewStatus=approved，
    // 与 live 文档的 approve/draft 状态无关，所以下面统计里单独列出。
    console.info(
      JSON.stringify({
        datasource: "ecommerce_sqlite(demo)",
        scanned: DEMO_SCHEMA_DOCUMENTS.length,
        deviation: "P2-07: 显式混入 demo 文档，生产环境不应使用",
      }),
    );
    documents.push(...DEMO_SCHEMA_DOCUMENTS);
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
  const demoDocuments = documents.filter(
    (doc) => doc.datasourceId === "ecommerce_sqlite",
  );
  const approvedCount = liveDocuments.filter(
    (doc) => doc.reviewStatus === "approved",
  ).length;
  const byDatasource = documents.reduce<Record<string, number>>((acc, doc) => {
    const key = doc.datasourceId ?? "(none)";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  console.info(
    JSON.stringify({
      action: dryRun ? "dry-run" : "rebuild",
      approval: approve ? "explicit-approve" : "draft-preview",
      alias: resolveMetadataAlias(),
      totalDocuments: documents.length,
      liveDocuments: liveDocuments.length,
      demoDocuments: demoDocuments.length,
      demoIncluded: includeDemo,
      byDatasource,
      approvedLiveDocuments: approvedCount,
      embedding: summarizeEmbeddingConfig(),
    }),
  );

  if (dryRun) return;

  if (includeDemo) {
    console.warn(
      "[P2-07 例外] 本次重建包含 demo datasource（ecommerce_sqlite）。" +
        "生产索引要求不含 demo datasource，请确认这是本地开发环境。",
    );
  }

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
