import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { dbPath, sql, params } = workerData;

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const start = Date.now();
  try {
    const stmt = db.prepare(sql);
    const rows = (
      Array.isArray(params) && params.length > 0
        ? stmt.all(...params)
        : stmt.all()
    ) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    parentPort?.postMessage({
      rows,
      columns,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    parentPort?.postMessage({
      rows: [],
      columns: [],
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    db.close();
  }
} catch (err) {
  parentPort?.postMessage({
    rows: [],
    columns: [],
    durationMs: 0,
    error: err instanceof Error ? err.message : String(err),
  });
}
