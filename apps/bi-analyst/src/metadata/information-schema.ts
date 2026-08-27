import type { ScannedTable } from "./scan-documents.js";

/**
 * INFORMATION_SCHEMA.COLUMNS 行的方言无关投影。
 * MySQL / PostgreSQL 查询结果均可映射到此结构后再解析。
 */
export interface InformationSchemaColumnRow {
  table_schema?: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable?: string | boolean | number | null;
  /** MySQL: YES/NO；PG: 也可来自 character_maximum_length 等，此处忽略 */
}

export interface GroupInformationSchemaOptions {
  /** 仅保留指定 schema（MySQL database / PG schema） */
  schema?: string;
  tables?: string[];
}

function isNotNull(value: InformationSchemaColumnRow["is_nullable"]): boolean {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") {
    const v = value.trim().toUpperCase();
    if (v === "NO" || v === "FALSE" || v === "0") return true;
    if (v === "YES" || v === "TRUE" || v === "1") return false;
  }
  return false;
}

/**
 * 将 INFORMATION_SCHEMA 列行按表分组为 ScannedTable[]。
 * 不执行任何数据库访问——便于无真实 MySQL/PG 时做契约测试。
 */
export function groupInformationSchemaColumns(
  rows: InformationSchemaColumnRow[],
  options: GroupInformationSchemaOptions = {},
): ScannedTable[] {
  const allowTables = options.tables?.length
    ? new Set(options.tables)
    : undefined;
  const byTable = new Map<string, ScannedTable>();

  for (const row of rows) {
    if (
      options.schema &&
      row.table_schema &&
      row.table_schema !== options.schema
    ) {
      continue;
    }
    const table = row.table_name;
    if (!table || !row.column_name) continue;
    if (allowTables && !allowTables.has(table)) continue;

    let scanned = byTable.get(table);
    if (!scanned) {
      scanned = { name: table, columns: [] };
      byTable.set(table, scanned);
    }
    scanned.columns.push({
      name: row.column_name,
      type: (row.data_type || "UNKNOWN").toUpperCase(),
      notnull: isNotNull(row.is_nullable),
    });
  }

  return [...byTable.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 推荐的 MySQL 内省 SQL（只读） */
export const MYSQL_INFORMATION_SCHEMA_SQL = `
SELECT TABLE_SCHEMA AS table_schema,
       TABLE_NAME AS table_name,
       COLUMN_NAME AS column_name,
       DATA_TYPE AS data_type,
       IS_NULLABLE AS is_nullable
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, ORDINAL_POSITION
`.trim();

/** 推荐的 PostgreSQL 内省 SQL（只读） */
export const POSTGRES_INFORMATION_SCHEMA_SQL = `
SELECT table_schema,
       table_name,
       column_name,
       data_type,
       is_nullable
FROM information_schema.columns
WHERE table_schema = $1
ORDER BY table_name, ordinal_position
`.trim();
