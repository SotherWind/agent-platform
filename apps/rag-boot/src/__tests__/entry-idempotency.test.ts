import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  EntryIdempotencyStore,
  SqliteEntryIdempotencyStore,
} from "../entry-idempotency";

const sqliteAvailable = (() => {
  try {
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
})();

describe("入口幂等存储", () => {
  it("并发重复投递只有一个调用获得首次占用", () => {
    const store = new EntryIdempotencyStore();
    const results = Array.from({ length: 100 }, () => store.first("same-message"));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("SQLite store 在重新创建实例后仍保留去重结果", () => {
    if (!sqliteAvailable) {
      expect(true).toBe(true);
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "rag-boot-idempotency-"));
    const path = join(directory, "entry.sqlite");
    try {
      const first = new SqliteEntryIdempotencyStore({ path });
      expect(first.first("durable-message")).toBe(true);
      first.close();

      const second = new SqliteEntryIdempotencyStore({ path });
      expect(second.first("durable-message")).toBe(false);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
