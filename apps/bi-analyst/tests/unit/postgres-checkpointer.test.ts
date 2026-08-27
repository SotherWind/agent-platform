import assert from "node:assert/strict";
import pg from "pg";
import {
  PostgresCheckpointSaver,
  resolveCheckpointConnectionFromEnv,
} from "../../src/session/postgres-checkpointer.js";
import { test, section, addSkipped } from "../helpers/runner.js";

export async function testPostgresCheckpointer() {
  section("PostgresCheckpointSaver（可选 Docker）");

  await test("put/getTuple/deleteThread Docker 合约（可选）", async () => {
    const ok = await canConnect();
    if (!ok) {
      console.log("  ⊘ 跳过：未检测到 Docker PostgreSQL（pnpm docker:up）");
      addSkipped(1);
      return;
    }

    const saver = new PostgresCheckpointSaver({
      connectionString: resolveCheckpointConnectionFromEnv(),
    });
    const threadId = `tenant-1:user-1:pg-cp-${Date.now()}`;
    try {
      const checkpoint = {
        v: 4 as const,
        id: "00000000-0000-4000-8000-0000000000aa",
        ts: new Date().toISOString(),
        channel_values: { messages: [] as unknown[] },
        channel_versions: { messages: 1 },
        versions_seen: {},
      };
      await saver.put(
        { configurable: { thread_id: threadId } },
        checkpoint,
        { source: "test", step: 1, writes: {}, parents: {} },
      );

      const tuple = await saver.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_id: checkpoint.id,
        },
      });
      assert.ok(tuple);
      assert.equal(tuple?.checkpoint.id, checkpoint.id);

      await saver.deleteThread(threadId);
      const after = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      assert.equal(after, undefined);
    } finally {
      await saver.deleteThread(threadId).catch(() => {});
      await saver.close();
    }
  });
}

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: resolveCheckpointConnectionFromEnv(),
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
