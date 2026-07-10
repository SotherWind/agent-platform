import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, seedDatabase } from "../../src/db/seed";

export function createTestDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `bi-analyst-test-${process.pid}-${Date.now()}.db`,
  );
  const db = createDatabase(dbPath);
  seedDatabase(db);
  return { db, dbPath };
}

export function cleanupDb(dbPath: string) {
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }
}

export const EXEC_CTX = {
  dataSourceId: "test",
  tenantId: "tenant-1",
  timeoutMs: 5000,
} as const;
