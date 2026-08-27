import type Database from "better-sqlite3";
import type { SchemaDocument } from "./types.js";
import { gradeColumn, shouldIndexColumn } from "./grading.js";
import {
  buildColumnContent,
  documentsFromScannedTables,
  inferFieldRole,
  type ScannedTable,
  type SchemaScanOptions,
} from "./scan-documents.js";
import {
  groupInformationSchemaColumns,
  type InformationSchemaColumnRow,
} from "./information-schema.js";

export type { ScannedTable, SchemaScanOptions } from "./scan-documents.js";
export {
  buildColumnContent,
  documentsFromScannedTables,
  inferFieldRole,
} from "./scan-documents.js";
export {
  groupInformationSchemaColumns,
  MYSQL_INFORMATION_SCHEMA_SQL,
  POSTGRES_INFORMATION_SCHEMA_SQL,
  type InformationSchemaColumnRow,
} from "./information-schema.js";

function listSqliteTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'agent_%' AND name NOT LIKE 'langgraph_%'
         AND name NOT LIKE 'audit_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function scanSqliteTable(
  db: Database.Database,
  table: string,
): ScannedTable {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;
  return {
    name: table,
    columns: cols.map((c) => ({
      name: c.name,
      type: c.type || "TEXT",
      notnull: Boolean(c.notnull),
    })),
  };
}

/** 从 SQLite 内省 schema 并生成可索引的 SchemaDocument 列表 */
export function scanSqliteSchema(
  db: Database.Database,
  options: SchemaScanOptions,
): SchemaDocument[] {
  const tableNames = options.tables?.length
    ? options.tables
    : listSqliteTables(db);
  const tables = tableNames.map((name) => scanSqliteTable(db, name));
  return documentsFromScannedTables(tables, options);
}

/**
 * 从 MySQL INFORMATION_SCHEMA 查询结果生成文档（不连库）。
 * 真实执行时用 MYSQL_INFORMATION_SCHEMA_SQL + 参数 schema。
 */
export function scanMysqlSchemaFromRows(
  rows: InformationSchemaColumnRow[],
  options: SchemaScanOptions & { schema?: string },
): SchemaDocument[] {
  const tables = groupInformationSchemaColumns(rows, {
    schema: options.schema,
    tables: options.tables,
  });
  return documentsFromScannedTables(tables, {
    ...options,
    dialectFamily: "mysql",
  });
}

/**
 * 从 PostgreSQL information_schema 查询结果生成文档（不连库）。
 * 真实执行时用 POSTGRES_INFORMATION_SCHEMA_SQL + 参数 schema。
 */
export function scanPostgresSchemaFromRows(
  rows: InformationSchemaColumnRow[],
  options: SchemaScanOptions & { schema?: string },
): SchemaDocument[] {
  const tables = groupInformationSchemaColumns(rows, {
    schema: options.schema,
    tables: options.tables,
  });
  return documentsFromScannedTables(tables, {
    ...options,
    dialectFamily: "postgresql",
  });
}

export interface ColdColumnInfo {
  table: string;
  name: string;
  type: string;
  fieldRole: SchemaDocument["fieldRole"];
  grade: ReturnType<typeof gradeColumn>;
}

/**
 * 冷门列动态 introspection：对未编入索引的列按需返回元数据（L3 或未扫描列）。
 * 供 RAG 失败二次召回使用，不默认写入向量库。
 */
export function introspectColdColumns(
  db: Database.Database,
  options: {
    datasourceId: string;
    tables: string[];
    /** 已索引列名集合：table.column */
    indexedColumns?: Set<string>;
  },
): ColdColumnInfo[] {
  const indexed = options.indexedColumns ?? new Set<string>();
  const cold: ColdColumnInfo[] = [];

  for (const tableName of options.tables) {
    const scanned = scanSqliteTable(db, tableName);
    for (const col of scanned.columns) {
      const key = `${tableName}.${col.name}`;
      const fieldRole = inferFieldRole(col.name);
      const grade = gradeColumn({ fieldRole, columnName: col.name });
      if (indexed.has(key) && shouldIndexColumn(grade)) continue;
      if (!indexed.has(key) || grade === "L3") {
        cold.push({
          table: tableName,
          name: col.name,
          type: col.type,
          fieldRole,
          grade,
        });
      }
    }
  }
  return cold;
}

/** 将冷门列转为不可索引的 fallback SchemaDocument（reviewStatus=draft） */
export function coldColumnsToDocuments(
  cold: ColdColumnInfo[],
  options: SchemaScanOptions,
): SchemaDocument[] {
  return cold.map((col) => ({
    id: `${options.datasourceId}.${col.table}.${col.name}`,
    docType: "column" as const,
    content: buildColumnContent(options.datasourceId, col.table, {
      name: col.name,
      type: col.type,
    }),
    datasourceId: options.datasourceId,
    domain: options.domain,
    dialectFamily: options.dialectFamily,
    table: col.table,
    column: col.name,
    fieldRole: col.fieldRole,
    reviewStatus: "draft" as const,
    tags: [col.type, col.grade, "cold-introspection"],
    sensitivity:
      col.grade === "L3" && /pii|phone|email|id_card/.test(col.name)
        ? ("pii" as const)
        : ("normal" as const),
  }));
}
