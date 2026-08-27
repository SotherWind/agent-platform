import mysql from "mysql2/promise";
import pg from "pg";
import fs from "node:fs";
import type { SchemaDocument } from "./types.js";
import {
  MYSQL_INFORMATION_SCHEMA_SQL,
  POSTGRES_INFORMATION_SCHEMA_SQL,
  type InformationSchemaColumnRow,
} from "./information-schema.js";
import {
  scanMysqlSchemaFromRows,
  scanPostgresSchemaFromRows,
  type SchemaScanOptions,
} from "./scanner.js";
import {
  resolveTlsOptions,
  toMysqlSslConfig,
  toPostgresSslConfig,
} from "../datasource/tls.js";

export interface LiveScanConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** MySQL: database name as schema；PG: schema name，默认 public */
  schema?: string;
  ssl?: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

function mapRows(rows: Record<string, unknown>[]): InformationSchemaColumnRow[] {
  return rows.map((r) => ({
    table_schema: String(r.table_schema ?? r.TABLE_SCHEMA ?? ""),
    table_name: String(r.table_name ?? r.TABLE_NAME ?? ""),
    column_name: String(r.column_name ?? r.COLUMN_NAME ?? ""),
    data_type: String(r.data_type ?? r.DATA_TYPE ?? ""),
    is_nullable: (r.is_nullable ?? r.IS_NULLABLE) as string | null,
  }));
}

/** 连接真实 MySQL，查询 INFORMATION_SCHEMA 并生成 SchemaDocument */
export async function scanMysqlSchemaLive(
  conn: LiveScanConnection,
  options: Omit<SchemaScanOptions, "dialectFamily"> & {
    dialectFamily?: SchemaScanOptions["dialectFamily"];
  },
): Promise<SchemaDocument[]> {
  const schema = conn.schema ?? conn.database;
  const tls = resolveTlsOptions({
    ssl: conn.ssl,
    rejectUnauthorized: conn.rejectUnauthorized,
    ca: conn.ca,
    cert: conn.cert,
    key: conn.key,
    requireVerified: true,
  });
  const pool = mysql.createPool({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: toMysqlSslConfig(tls),
    connectionLimit: 2,
  });
  try {
    const [rows] = await pool.query(MYSQL_INFORMATION_SCHEMA_SQL, [schema]);
    return scanMysqlSchemaFromRows(mapRows(rows as Record<string, unknown>[]), {
      ...options,
      dialectFamily: "mysql",
      schema,
    });
  } finally {
    await pool.end();
  }
}

/** 连接真实 PostgreSQL，查询 information_schema 并生成 SchemaDocument */
export async function scanPostgresSchemaLive(
  conn: LiveScanConnection,
  options: Omit<SchemaScanOptions, "dialectFamily"> & {
    dialectFamily?: SchemaScanOptions["dialectFamily"];
  },
): Promise<SchemaDocument[]> {
  const schema = conn.schema ?? "public";
  const tls = resolveTlsOptions({
    ssl: conn.ssl,
    rejectUnauthorized: conn.rejectUnauthorized,
    ca: conn.ca,
    cert: conn.cert,
    key: conn.key,
    requireVerified: true,
  });
  const client = new pg.Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: toPostgresSslConfig(tls),
  });
  try {
    await client.connect();
    const result = await client.query(POSTGRES_INFORMATION_SCHEMA_SQL, [
      schema,
    ]);
    return scanPostgresSchemaFromRows(mapRows(result.rows), {
      ...options,
      dialectFamily: "postgresql",
      schema,
    });
  } finally {
    await client.end();
  }
}

export function dockerMysqlConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveScanConnection {
  return {
    host: env.BI_MYSQL_HOST ?? "127.0.0.1",
    port: Number(env.BI_MYSQL_PORT ?? 3306),
    user: env.BI_MYSQL_USER ?? "bi",
    password: env.BI_MYSQL_PASSWORD ?? "bi_dev",
    database: env.BI_MYSQL_DATABASE ?? "retail",
    schema: env.BI_MYSQL_SCHEMA ?? env.BI_MYSQL_DATABASE ?? "retail",
    ssl: env.BI_MYSQL_SSL === "1",
    rejectUnauthorized: env.BI_MYSQL_TLS_REJECT_UNAUTHORIZED !== "0",
    ca: readOptionalPem(env.BI_MYSQL_TLS_CA_PATH),
    cert: readOptionalPem(env.BI_MYSQL_TLS_CERT_PATH),
    key: readOptionalPem(env.BI_MYSQL_TLS_KEY_PATH),
  };
}

/** Docker MariaDB（默认宿主机 3307） */
export function dockerMariadbConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveScanConnection {
  return {
    host: env.BI_MARIADB_HOST ?? "127.0.0.1",
    port: Number(env.BI_MARIADB_PORT ?? 3307),
    user: env.BI_MARIADB_USER ?? "bi",
    password: env.BI_MARIADB_PASSWORD ?? "bi_dev",
    database: env.BI_MARIADB_DATABASE ?? "retail",
    schema: env.BI_MARIADB_SCHEMA ?? env.BI_MARIADB_DATABASE ?? "retail",
    ssl: env.BI_MARIADB_SSL === "1",
    rejectUnauthorized: env.BI_MARIADB_TLS_REJECT_UNAUTHORIZED !== "0",
    ca: readOptionalPem(env.BI_MARIADB_TLS_CA_PATH),
    cert: readOptionalPem(env.BI_MARIADB_TLS_CERT_PATH),
    key: readOptionalPem(env.BI_MARIADB_TLS_KEY_PATH),
  };
}

export function dockerPostgresConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveScanConnection {
  return {
    host: env.BI_PG_HOST ?? "127.0.0.1",
    port: Number(env.BI_PG_PORT ?? 5432),
    user: env.BI_PG_USER ?? "bi",
    password: env.BI_PG_PASSWORD ?? "bi_dev",
    database: env.BI_PG_DATABASE ?? "retail",
    schema: env.BI_PG_SCHEMA ?? "public",
    ssl: env.BI_PG_SSL === "1",
    rejectUnauthorized: env.BI_PG_TLS_REJECT_UNAUTHORIZED !== "0",
    ca: readOptionalPem(env.BI_PG_TLS_CA_PATH),
    cert: readOptionalPem(env.BI_PG_TLS_CERT_PATH),
    key: readOptionalPem(env.BI_PG_TLS_KEY_PATH),
  };
}

function readOptionalPem(filePath: string | undefined): string | undefined {
  const value = filePath?.trim();
  return value ? fs.readFileSync(value, "utf8") : undefined;
}
