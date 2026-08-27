import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface OpenSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  createParent?: boolean;
}

/** Open an operator-provided SQLite database without creating demo schema/data. */
export function openSqliteDatabase(
  dbPath: string,
  options: OpenSqliteOptions = {},
): Database.Database {
  if (options.createParent && dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const databaseOptions: Database.Options = {};
  if (options.readonly !== undefined) {
    databaseOptions.readonly = options.readonly;
  }
  if (options.fileMustExist !== undefined) {
    databaseOptions.fileMustExist = options.fileMustExist;
  }
  return new Database(dbPath, databaseOptions);
}

/** Read SQLite schema metadata for local tooling and the legacy fallback path. */
export function getSchema(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];

  return {
    tables: tables.map((table) => {
      const escapedTable = table.name.replaceAll("'", "''");
      const columns = db
        .prepare(`PRAGMA table_info('${escapedTable}')`)
        .all() as Array<{ name: string; type: string }>;
      return {
        name: table.name,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          description:
            column.name === "user_id" ? "关联 users.id 的外键" : undefined,
        })),
      };
    }),
  };
}
