import assert from "node:assert/strict";
import { SqliteExecutor } from "../../src/datasource/executors/sqlite.js";
import type { SqlExecutor } from "../../src/datasource/types.js";
import { createTestDb, cleanupDb } from "../helpers/db.js";
import { test, section } from "../helpers/runner.js";

const BASE_REQUEST = {
  dataSourceId: "test",
  tenantId: "tenant-1",
  subjectId: "user-test",
  timeoutMs: 5000,
} as const;

/** 所有 SqlExecutor 实现必须通过的 contract 行为 */
export async function runSqlExecutorContract(
  label: string,
  factory: () => { executor: SqlExecutor; cleanup: () => void },
) {
  section(`Contract: SqlExecutor (${label})`);

  await test("合法 SELECT 返回行与列", async () => {
    const { executor, cleanup } = factory();
    try {
      const result = await executor.execute(
        {
          ...BASE_REQUEST,
          sql: "SELECT city, COUNT(*) AS cnt FROM users GROUP BY city",
        },
        new AbortController().signal,
      );
      assert.equal(result.isEmpty, false);
      assert.ok(result.columns.includes("city"));
      assert.ok(result.rows.length >= 1);
      assert.ok(result.stats && result.stats.rowCount >= 1);
    } finally {
      cleanup();
    }
  });

  await test("DML 语句被校验器拒绝", async () => {
    const { executor, cleanup } = factory();
    try {
      const result = await executor.execute(
        {
          ...BASE_REQUEST,
          sql: "UPDATE users SET city = 'x' WHERE id = 1",
        },
        new AbortController().signal,
      );
      assert.equal(result.isEmpty, true);
      assert.equal(result.failureKind, "policy_rejected");
      assert.ok(result.error);
      assert.doesNotMatch(result.error!, /SQLITE|UPDATE/i);
    } finally {
      cleanup();
    }
  });

  await test("healthCheck 返回 healthy", async () => {
    const { executor, cleanup } = factory();
    try {
      const health = await executor.healthCheck();
      assert.equal(health.healthy, true);
      assert.ok(typeof health.latencyMs === "number");
    } finally {
      cleanup();
    }
  });

  await test("AbortSignal 取消执行", async () => {
    const prevSync = process.env.BI_SQLITE_SYNC;
    process.env.BI_SQLITE_SYNC = "0";

    const { executor, cleanup } = factory();
    const controller = new AbortController();

    try {
      const promise = executor.execute(
        {
          ...BASE_REQUEST,
          sql: `WITH RECURSIVE slow(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM slow WHERE n < 10000000
          ) SELECT COUNT(*) FROM slow`,
          timeoutMs: 30_000,
        },
        controller.signal,
      );

      controller.abort();
      const result = await promise;
      assert.equal(result.isEmpty, true);
      assert.equal(result.failureKind, "timeout");
      assert.match(result.error!, /取消|超时/);
    } finally {
      if (prevSync === undefined) delete process.env.BI_SQLITE_SYNC;
      else process.env.BI_SQLITE_SYNC = prevSync;
      cleanup();
    }
  });
}

export async function testSqlExecutorContract() {
  await runSqlExecutorContract("SqliteExecutor", () => {
    const { db, dbPath } = createTestDb();
    const executor = new SqliteExecutor({
      db,
      dataSourceId: "test",
    });
    return {
      executor,
      cleanup: () => {
        db.close();
        cleanupDb(dbPath);
      },
    };
  });
}
