import type { DialectFamily } from "../datasource/types.js";
import type { SchemaDocument } from "./types.js";
import { gradeColumn, shouldIndexColumn } from "./grading.js";

/** 方言无关的表内省结果 */
export interface ScannedTable {
  name: string;
  columns: Array<{ name: string; type: string; notnull: boolean }>;
}

export interface SchemaScanOptions {
  datasourceId: string;
  domain: string;
  dialectFamily: DialectFamily;
  /** 仅扫描这些表；缺省扫描全部传入表 */
  tables?: string[];
  reviewStatus?: SchemaDocument["reviewStatus"];
}

export function inferFieldRole(columnName: string): SchemaDocument["fieldRole"] {
  const n = columnName.toLowerCase();
  if (/_at$|_date$|^date$/.test(n)) return "time_key";
  if (/^id$|_id$/.test(n)) return "join_key";
  if (/amount|total|price|pay|gmv|count|qty/.test(n)) return "metric";
  if (/city|region|channel|category|status|type/.test(n)) return "dimension";
  if (/tenant|org|dept/.test(n)) return "policy_key";
  return "filter";
}

export function buildColumnContent(
  datasourceId: string,
  table: string,
  column: { name: string; type: string },
): string {
  return [
    `# 字段：${datasourceId}.${table}.${column.name}`,
    "",
    `数据类型：${column.type}`,
    `表：${table}`,
  ].join("\n");
}

/**
 * 将已内省的表结构转为可索引 SchemaDocument。
 * SQLite / MySQL / PG scanner 共用此装配逻辑。
 */
export function documentsFromScannedTables(
  tables: ScannedTable[],
  options: SchemaScanOptions,
): SchemaDocument[] {
  const allow = options.tables?.length
    ? new Set(options.tables)
    : undefined;
  const reviewStatus = options.reviewStatus ?? "draft";
  const docs: SchemaDocument[] = [];

  docs.push({
    id: `datasource:${options.datasourceId}`,
    docType: "datasource",
    content: `数据源 ${options.datasourceId}（${options.domain}）`,
    datasourceId: options.datasourceId,
    domain: options.domain,
    dialectFamily: options.dialectFamily,
    reviewStatus,
  });

  for (const scanned of tables) {
    if (allow && !allow.has(scanned.name)) continue;

    docs.push({
      id: `${options.datasourceId}.${scanned.name}`,
      docType: "table",
      content: `表 ${scanned.name}，共 ${scanned.columns.length} 列`,
      datasourceId: options.datasourceId,
      domain: options.domain,
      dialectFamily: options.dialectFamily,
      table: scanned.name,
      reviewStatus,
    });

    for (const col of scanned.columns) {
      const fieldRole = inferFieldRole(col.name);
      const grade = gradeColumn({ fieldRole, columnName: col.name });
      if (!shouldIndexColumn(grade)) continue;

      docs.push({
        id: `${options.datasourceId}.${scanned.name}.${col.name}`,
        docType: grade === "L1" ? "column" : "column_group",
        content: buildColumnContent(options.datasourceId, scanned.name, col),
        datasourceId: options.datasourceId,
        domain: options.domain,
        dialectFamily: options.dialectFamily,
        table: scanned.name,
        column: col.name,
        fieldRole,
        reviewStatus,
        tags: [col.type, grade],
      });
    }
  }

  return docs;
}
