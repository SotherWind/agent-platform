import assert from "node:assert/strict";
import {
  MetadataSyncScheduler,
  parseMetadataSyncScheduleFromEnv,
} from "../../src/metadata/sync-scheduler.js";
import { test, section } from "../helpers/runner.js";

export async function testMetadataSyncScheduler() {
  section("MetadataSyncScheduler");

  await test("parseMetadataSyncScheduleFromEnv 默认关闭", () => {
    const cfg = parseMetadataSyncScheduleFromEnv({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.intervalMs, 3_600_000);
    assert.equal(cfg.mode, "incremental");
  });

  await test("parse 开启与 rebuild 模式", () => {
    const cfg = parseMetadataSyncScheduleFromEnv({
      METADATA_SYNC_ENABLED: "1",
      METADATA_SYNC_INTERVAL_MS: "5000",
      METADATA_SYNC_MODE: "rebuild",
      METADATA_SYNC_RUN_ON_START: "true",
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.intervalMs, 5000);
    assert.equal(cfg.mode, "rebuild");
    assert.equal(cfg.runOnStart, true);
  });

  await test("runOnce 执行 job 并更新状态", async () => {
    let runs = 0;
    const scheduler = new MetadataSyncScheduler({
      config: {
        enabled: true,
        intervalMs: 60_000,
        mode: "incremental",
        runOnStart: false,
      },
      job: async () => {
        runs += 1;
      },
      now: () => 1_000_000,
    });
    await scheduler.runOnce();
    assert.equal(runs, 1);
    const status = scheduler.getStatus();
    assert.equal(status.runCount, 1);
    assert.equal(status.lastError, null);
    assert.equal(status.lastDurationMs, 0);
  });

  await test("重叠触发跳过", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const scheduler = new MetadataSyncScheduler({
      config: {
        enabled: true,
        intervalMs: 60_000,
        mode: "incremental",
        runOnStart: false,
      },
      job: async () => {
        await gate;
      },
    });
    const first = scheduler.runOnce();
    await scheduler.runOnce();
    assert.equal(scheduler.getSkippedOverlaps(), 1);
    release();
    await first;
    assert.equal(scheduler.getStatus().runCount, 1);
  });

  await test("job 失败记录 lastError", async () => {
    const scheduler = new MetadataSyncScheduler({
      config: {
        enabled: true,
        intervalMs: 60_000,
        mode: "incremental",
        runOnStart: false,
      },
      job: async () => {
        throw new Error("sync failed");
      },
    });
    await assert.rejects(() => scheduler.runOnce(), /sync failed/);
    assert.equal(scheduler.getStatus().lastError, "sync failed");
  });
}
