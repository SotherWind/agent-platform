import assert from "node:assert/strict";
import pg from "pg";
import {
  PostgresQueryHistoryStore,
  resolveHistoryConnectionFromEnv,
} from "../../src/history/postgres-store.js";
import { InMemoryQueryHistoryStore } from "../../src/history/store.js";
import type { QueryHistoryRecord, QueryHistoryStore } from "../../src/history/store.js";
import { SqliteQueryHistoryStore } from "../../src/history/sqlite-store.js";
import { createDatabase } from "../../src/db/seed.js";
import { test, section, addSkipped } from "../helpers/runner.js";

function sampleRecord(overrides: Partial<QueryHistoryRecord> = {}): QueryHistoryRecord {
  return {
    id: "h1",
    tenantId: "tenant-a",
    subjectId: "u1",
    requestId: "r1",
    traceId: "t1",
    query: "北京订单总额",
    finalAnswerPreview: "总额为 1000",
    queryPath: "metric",
    dataSourceId: "ecommerce_sqlite",
    needsClarification: false,
    createdAt: new Date().toISOString(),
    durationMs: 150,
    ...overrides,
  };
}

async function runHistoryStoreContract(store: QueryHistoryStore) {
  store.append(sampleRecord({ id: "h1", requestId: "r1", durationMs: 80 }));
  store.append(
    sampleRecord({
      id: "h2",
      requestId: "r2",
      subjectId: "u1",
      durationMs: 200,
      createdAt: new Date(Date.now() + 1).toISOString(),
    }),
  );
  store.append(
    sampleRecord({
      id: "h3",
      requestId: "r3",
      tenantId: "tenant-b",
      subjectId: "u2",
    }),
  );

  const items = store.list("tenant-a", "u1", { limit: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0]!.requestId, "r2");

  const slow = store.list("tenant-a", "u1", { minDurationMs: 100 });
  assert.equal(slow.length, 1);
  assert.equal(slow[0]!.requestId, "r2");

  const hit = store.getByRequestId("tenant-a", "u1", "r1");
  assert.ok(hit);
  assert.equal(hit!.query, "北京订单总额");
}

export async function testQueryHistoryStoreContract() {
  section("QueryHistoryStore 合约（内存 + SQLite + PG 可选）");

  await test("InMemoryQueryHistoryStore 合约", async () => {
    await runHistoryStoreContract(new InMemoryQueryHistoryStore());
  });

  await test("SqliteQueryHistoryStore 合约", async () => {
    const db = createDatabase(":memory:");
    try {
      const store = new SqliteQueryHistoryStore(db);
      await runHistoryStoreContract(store);
      assert.equal(store.size(), 3);
    } finally {
      db.close();
    }
  });

  await test("PostgresQueryHistoryStore Docker 合约（可选）", async () => {
    const ok = await canConnectPostgres();
    if (!ok) {
      console.log("  ⊘ 跳过：未检测到 Docker PostgreSQL（pnpm docker:up）");
      addSkipped(1);
      return;
    }

    const store = new PostgresQueryHistoryStore({
      connectionString: resolveHistoryConnectionFromEnv(),
    });
    try {
      await store.purgeAll();
      await store.appendAsync(
        sampleRecord({ id: "pg-h1", requestId: "r1", durationMs: 80 }),
      );
      await store.appendAsync(
        sampleRecord({
          id: "pg-h2",
          requestId: "r2",
          durationMs: 200,
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      );
      assert.equal(await store.sizeInDatabase(), 2);

      const fromDb = await store.listFromDatabase("tenant-a", "u1", {
        minDurationMs: 100,
      });
      assert.equal(fromDb.length, 1);
      assert.equal(fromDb[0]!.requestId, "r2");

      const recovered = new PostgresQueryHistoryStore({
        connectionString: resolveHistoryConnectionFromEnv(),
      });
      try {
        const afterRestart = await recovered.listAsync("tenant-a", "u1");
        assert.equal(afterRestart.length, 2);
        const byRequest = await recovered.getByRequestIdAsync(
          "tenant-a",
          "u1",
          "r2",
        );
        assert.equal(byRequest?.id, "pg-h2");
      } finally {
        await recovered.close();
      }
    } finally {
      await store.purgeAll();
      await store.close();
    }
  });
}

async function canConnectPostgres(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: resolveHistoryConnectionFromEnv(),
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
