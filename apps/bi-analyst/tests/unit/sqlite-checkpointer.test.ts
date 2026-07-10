import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../../src/db/seed.js";
import { SqliteCheckpointSaver } from "../../src/session/sqlite-checkpointer.js";
import { test, section } from "../helpers/runner.js";

export async function testSqliteCheckpointer() {
  section("SqliteCheckpointSaver (持久化 checkpointer)");

  await test("put/getTuple 跨实例恢复 checkpoint", async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `bi-checkpoint-${process.pid}-${Date.now()}.db`,
    );

    try {
      const db1 = createDatabase(dbPath);
      const saver1 = new SqliteCheckpointSaver(db1);

      const checkpoint = {
        v: 4 as const,
        id: "00000000-0000-4000-8000-000000000001",
        ts: new Date().toISOString(),
        channel_values: { messages: [] as unknown[] },
        channel_versions: { messages: 1 },
        versions_seen: {},
      };
      const metadata = { source: "test", step: 1, writes: {}, parents: {} };

      await saver1.put(
        { configurable: { thread_id: "tenant-1:user-1:sess-a" } },
        checkpoint,
        metadata,
      );
      db1.close();

      const db2 = createDatabase(dbPath);
      const saver2 = new SqliteCheckpointSaver(db2);
      const tuple2 = await saver2.getTuple({
        configurable: {
          thread_id: "tenant-1:user-1:sess-a",
          checkpoint_id: checkpoint.id,
        },
      });
      assert.ok(tuple2);
      assert.equal(tuple2?.checkpoint.id, checkpoint.id);
      db2.close();
    } finally {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
  });

  await test("deleteThread 清除 checkpoint", async () => {
    const db = createDatabase(":memory:");
    const saver = new SqliteCheckpointSaver(db);
    const threadId = "tenant-1:user-1:sess-del";

    await saver.put(
      { configurable: { thread_id: threadId } },
      {
        v: 4,
        id: "00000000-0000-4000-8000-000000000002",
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: "test", step: 1, writes: {}, parents: {} },
    );

    await saver.deleteThread(threadId);
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    assert.equal(tuple, undefined);
    db.close();
  });
}
