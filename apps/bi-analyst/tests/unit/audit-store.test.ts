import assert from "node:assert/strict";
import { createDatabase } from "../../src/db/seed.js";
import { InMemoryAuditStore } from "../../src/audit/store.js";
import { SqliteAuditStore } from "../../src/audit/sqlite-store.js";
import {
  PostgresAuditStore,
  resolvePostgresAuditConnectionFromEnv,
} from "../../src/audit/postgres-store.js";
import type { AuditStore } from "../../src/audit/store.js";
import type { StructuredAuditEvent } from "../../src/audit/events.js";
import { test, section, addSkipped } from "../helpers/runner.js";
import pg from "pg";

function sampleEvents(): StructuredAuditEvent[] {
  const base = new Date().toISOString();
  return [
    {
      event: "request.accepted",
      requestId: "r1",
      traceId: "t1",
      subjectId: "u1",
      tenantId: "tenant-a",
      timestamp: base,
    },
    {
      event: "answer.completed",
      requestId: "r1",
      traceId: "t1",
      subjectId: "u1",
      tenantId: "tenant-a",
      durationMs: 120,
      metadata: { queryPath: "rag" },
      timestamp: new Date(Date.now() + 1).toISOString(),
    },
    {
      event: "request.failed",
      requestId: "r2",
      traceId: "t2",
      subjectId: "u2",
      tenantId: "tenant-b",
      failureKind: "rate_limited",
      timestamp: new Date(Date.now() + 2).toISOString(),
    },
  ];
}

async function runAuditStoreContract(name: string, store: AuditStore) {
  for (const event of sampleEvents()) {
    store.append(event);
  }
  assert.equal(store.size(), 3);

  const tenantA = store.query({ tenantId: "tenant-a", limit: 10 });
  assert.equal(tenantA.length, 2);
  assert.equal(tenantA[0]!.event, "answer.completed");

  const paged = store.query({ tenantId: "tenant-a", limit: 1, offset: 1 });
  assert.equal(paged.length, 1);
  assert.equal(paged[0]!.event, "request.accepted");

  const byEvent = store.query({
    tenantId: "tenant-b",
    event: "request.failed",
    limit: 5,
  });
  assert.equal(byEvent.length, 1);

  assert.equal(store.purgeOlderThan(0), 3);
  assert.equal(store.size(), 0);
}

export async function testAuditStoreContract() {
  section("AuditStore 合约（内存 + SQLite）");

  await test("InMemoryAuditStore 合约", async () => {
    await runAuditStoreContract("memory", new InMemoryAuditStore());
  });

  await test("SqliteAuditStore 合约", async () => {
    const db = createDatabase(":memory:");
    try {
      await runAuditStoreContract("sqlite", new SqliteAuditStore(db));
    } finally {
      db.close();
    }
  });

  await test("PostgresAuditStore Docker 合约（可选）", async () => {
    const ok = await canConnectPostgresAudit();
    if (!ok) {
      console.log("  ⊘ 跳过：未检测到 Docker PostgreSQL（pnpm docker:up）");
      addSkipped(1);
      return;
    }

    const store = new PostgresAuditStore({
      connectionString: resolvePostgresAuditConnectionFromEnv(),
    });
    try {
      await store.purgeOlderThanAsync(0);
      for (const event of sampleEvents()) {
        await store.appendAsync(event);
      }
      assert.equal(await store.sizeInDatabase(), 3);

      const tenantA = await store.queryFromDatabase({
        tenantId: "tenant-a",
        limit: 10,
      });
      assert.equal(tenantA.length, 2);
      assert.equal(tenantA[0]!.event, "answer.completed");

      const syncQuery = store.query({ tenantId: "tenant-a", limit: 10 });
      assert.equal(syncQuery.length, 2);

      const recovered = new PostgresAuditStore({
        connectionString: resolvePostgresAuditConnectionFromEnv(),
      });
      try {
        const afterRestart = await recovered.queryAsync({
          tenantId: "tenant-a",
          limit: 10,
        });
        assert.equal(afterRestart.length, 2);
      } finally {
        await recovered.close();
      }

      assert.equal(await store.purgeOlderThanAsync(0), 3);
      assert.equal(await store.sizeInDatabase(), 0);
    } finally {
      await store.close();
    }
  });
}

async function canConnectPostgresAudit(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: resolvePostgresAuditConnectionFromEnv(),
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
