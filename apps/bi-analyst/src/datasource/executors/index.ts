import type Database from "better-sqlite3";
import type { DataSourceConfig, SqlExecutor } from "../types.js";
import { createSqliteDataSourceConfig } from "../types.js";
import { SqliteExecutor } from "./sqlite.js";

export interface CreateExecutorOptions {
  db: Database.Database;
  config?: DataSourceConfig;
  maxRows?: number;
  allowedTables?: string[];
}

/** 根据数据源配置创建执行器（Phase 2 扩展 MySQL/PG） */
export function createExecutor(options: CreateExecutorOptions): SqlExecutor {
  const config =
    options.config ??
    createSqliteDataSourceConfig("default", options.db.name ?? ":memory:");

  switch (config.dialectFamily) {
    case "sqlite":
      return new SqliteExecutor({
        db: options.db,
        dataSourceId: config.id,
        maxRows: options.maxRows,
        allowedTables: options.allowedTables,
      });
    default:
      throw new Error(
        `方言 ${config.dialectFamily} 的执行器尚未实现（Phase 2）`,
      );
  }
}

export { SqliteExecutor } from "./sqlite.js";
