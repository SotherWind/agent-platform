#!/usr/bin/env tsx
/**
 * 元数据同步调度进程（Phase F 外部 cron 钩子）。
 *
 * 用法：
 *   METADATA_SYNC_ENABLED=1 METADATA_SYNC_INTERVAL_MS=60000 pnpm sync:metadata:schedule
 *   METADATA_SYNC_ENABLED=1 METADATA_SYNC_RUN_ON_START=1 pnpm sync:metadata:schedule
 *
 * 亦可由系统 crontab 直接调用一次性入口：
 *   pnpm sync:metadata
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/db/seed.js";
import { scanSqliteSchema } from "../src/metadata/scanner.js";
import { runMetadataSync } from "../src/metadata/sync-runner.js";
import { createMetadataStack } from "../src/metadata/metadata-factory.js";
import {
  MetadataSyncScheduler,
  parseMetadataSyncScheduleFromEnv,
} from "../src/metadata/sync-scheduler.js";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

async function runSyncJob(mode: "incremental" | "rebuild"): Promise<void> {
  const dbPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../data/ecommerce.db",
  );
  const db = createDatabase(dbPath);
  try {
    const scanned = scanSqliteSchema(db, {
      datasourceId: "ecommerce_sqlite",
      domain: "retail",
      dialectFamily: "sqlite",
    });
    const { indexer } = createMetadataStack();
    const previous = await indexer.readCurrentDocuments();
    const result = await runMetadataSync({
      indexer,
      nextDocuments: scanned,
      previousDocuments: previous,
      mode,
      shardByTable: true,
    });
    console.info(
      JSON.stringify({
        event: "metadata_sync_ok",
        mode: result.mode,
        upserted: result.upserted,
        tombstoned: result.tombstoned,
        collection: result.collection,
        at: new Date().toISOString(),
      }),
    );
  } finally {
    db.close();
  }
}

async function main() {
  const config = parseMetadataSyncScheduleFromEnv(process.env);
  if (!config.enabled) {
    console.error(
      "METADATA_SYNC_ENABLED 未开启。设置 METADATA_SYNC_ENABLED=1 后重试，或使用一次性 pnpm sync:metadata。",
    );
    process.exit(2);
  }

  console.info(
    JSON.stringify({
      event: "metadata_sync_scheduler_start",
      intervalMs: config.intervalMs,
      mode: config.mode,
      runOnStart: config.runOnStart,
    }),
  );

  const scheduler = new MetadataSyncScheduler({
    config,
    job: async () => {
      await runSyncJob(config.mode);
    },
  });

  const shutdown = () => {
    scheduler.stop();
    console.info(
      JSON.stringify({
        event: "metadata_sync_scheduler_stop",
        status: scheduler.getStatus(),
      }),
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  scheduler.start();
}

main().catch((err) => {
  console.error("sync:metadata:schedule 失败:", err);
  process.exit(1);
});
