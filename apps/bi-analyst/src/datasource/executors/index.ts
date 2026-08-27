import type Database from "better-sqlite3";
import type { DataSourceConfig, SqlExecutor } from "../types.js";
import { createSqliteDataSourceConfig } from "../types.js";
import { SqliteExecutor } from "./sqlite.js";
import { MysqlExecutor, type MysqlQueryClient } from "./mysql.js";
import { PostgresExecutor, type PostgresQueryClient } from "./postgresql.js";
import { OracleExecutor, type OracleQueryClient } from "./oracle.js";
import {
  SqlServerExecutor,
  type SqlServerQueryClient,
} from "./sqlserver.js";
import {
  PlannedDialectExecutor,
  isPlannedDialectFamily,
} from "./planned-stub.js";
import { assertExecutableSupportStatus } from "../capabilities.js";
import { TenantConcurrencyLimiter } from "../pool.js";

export interface CreateExecutorOptions {
  db?: Database.Database;
  config?: DataSourceConfig;
  maxRows?: number;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  requireFilterTables?: string[];
  maxJoins?: number;
  maxCteDepth?: number;
  mysqlClient?: MysqlQueryClient;
  postgresClient?: PostgresQueryClient;
  /** 注入后走 OracleExecutor；缺省仍为 PlannedDialectExecutor */
  oracleClient?: OracleQueryClient;
  /** 注入后走 SqlServerExecutor；缺省仍为 PlannedDialectExecutor */
  sqlServerClient?: SqlServerQueryClient;
  /** 用于生产门禁校验 */
  environment?: string;
  tenantConcurrencyMax?: number;
}

/** 根据数据源配置创建执行器 */
export function createExecutor(options: CreateExecutorOptions): SqlExecutor {
  const config =
    options.config ??
    createSqliteDataSourceConfig(
      "default",
      options.db?.name ?? ":memory:",
    );

  if (options.environment) {
    assertExecutableSupportStatus(
      config.supportStatus,
      options.environment,
    );
  }

  switch (config.dialectFamily) {
    case "sqlite":
      if (!options.db) {
        throw new Error("SQLite 执行器需要 db 实例");
      }
      return new SqliteExecutor({
        db: options.db,
        dataSourceId: config.id,
        maxRows: options.maxRows,
        allowedTables: options.allowedTables,
        allowedColumns: options.allowedColumns,
        requireFilterTables: options.requireFilterTables,
        maxJoins: options.maxJoins,
        maxCteDepth: options.maxCteDepth,
      });
    case "mysql":
      if (!options.mysqlClient) {
        throw new Error("MySQL/MariaDB 执行器需要 mysqlClient");
      }
      return new MysqlExecutor({
        dataSourceId: config.id,
        client: options.mysqlClient,
        maxRows: options.maxRows,
        allowedTables: options.allowedTables,
        allowedColumns: options.allowedColumns,
        enableExplainCost: true,
        tenantLimiter: options.tenantConcurrencyMax
          ? new TenantConcurrencyLimiter(options.tenantConcurrencyMax)
          : undefined,
      });
    case "postgresql":
      if (!options.postgresClient) {
        throw new Error("PostgreSQL 执行器需要 postgresClient");
      }
      return new PostgresExecutor({
        dataSourceId: config.id,
        client: options.postgresClient,
        maxRows: options.maxRows,
        allowedTables: options.allowedTables,
        allowedColumns: options.allowedColumns,
        enableExplainCost: true,
        tenantLimiter: options.tenantConcurrencyMax
          ? new TenantConcurrencyLimiter(options.tenantConcurrencyMax)
          : undefined,
      });
    case "oracle":
      if (options.oracleClient) {
        return new OracleExecutor({
          dataSourceId: config.id,
          client: options.oracleClient,
          maxRows: options.maxRows,
          allowedTables: options.allowedTables,
          allowedColumns: options.allowedColumns,
        });
      }
      return new PlannedDialectExecutor({
        dataSourceId: config.id,
        dialectFamily: "oracle",
        productType: config.productType,
      });
    case "tsql":
      if (options.sqlServerClient) {
        return new SqlServerExecutor({
          dataSourceId: config.id,
          client: options.sqlServerClient,
          maxRows: options.maxRows,
          allowedTables: options.allowedTables,
          allowedColumns: options.allowedColumns,
        });
      }
      return new PlannedDialectExecutor({
        dataSourceId: config.id,
        dialectFamily: "tsql",
        productType: config.productType,
      });
    default:
      if (isPlannedDialectFamily(config.dialectFamily)) {
        return new PlannedDialectExecutor({
          dataSourceId: config.id,
          dialectFamily: config.dialectFamily,
          productType: config.productType,
        });
      }
      throw new Error(
        `方言 ${config.dialectFamily} 的执行器尚未认证实现`,
      );
  }
}

export { SqliteExecutor } from "./sqlite.js";
export { MysqlExecutor, createMysqlPoolClient } from "./mysql.js";
export { PostgresExecutor, createPostgresPoolClient } from "./postgresql.js";
export { OracleExecutor, createOraclePoolClient } from "./oracle.js";
export {
  SqlServerExecutor,
  createSqlServerClient,
} from "./sqlserver.js";
export {
  PlannedDialectExecutor,
  isPlannedDialectFamily,
  PLANNED_DIALECT_FAMILIES,
} from "./planned-stub.js";
