import type Database from "better-sqlite3";
import type { FieldRole } from "./types.js";
import { gradeColumn } from "./grading.js";

export interface IntrospectedColumn {
  table: string;
  column: string;
  type: string;
  notnull: boolean;
  grade: ReturnType<typeof gradeColumn>;
  fieldRole: FieldRole;
}

export interface ColdColumnIntrospectOptions {
  datasourceId: string;
  /** 已索引列 id 集合，如 `ds.table.col` */
  indexedColumnIds: Set<string> | string[];
  tables?: string[];
  /** 仅返回 L3 冷门列（默认 true） */
  onlyL3?: boolean;
}

function inferFieldRole(columnName: string): FieldRole {
  const n = columnName.toLowerCase();
  if (/_at$|_date$|^date$/.test(n)) return "time_key";
  if (/^id$|_id$/.test(n)) return "join_key";
  if (/amount|total|price|pay|gmv|count|qty/.test(n)) return "metric";
  if (/city|region|channel|category|status|type/.test(n)) return "dimension";
  if (/tenant|org|dept/.test(n)) return "policy_key";
  if (/flag$|_flag$|internal|etl|tmp/.test(n)) return "internal";
  return "filter";
}

/**
 * 冷门列动态 introspection：当 RAG 未覆盖某字段时，可从库内省补回（不入库）。
 * 默认只返回 L3 / 未索引列，供二次召回。
 */
export function introspectColdColumns(
  db: Database.Database,
  options: ColdColumnIntrospectOptions,
): IntrospectedColumn[] {
  const indexed = new Set(
    Array.isArray(options.indexedColumnIds)
      ? options.indexedColumnIds
      : options.indexedColumnIds,
  );
  const onlyL3 = options.onlyL3 !== false;

  const tableRows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'agent_%' AND name NOT LIKE 'langgraph_%'
         AND name NOT LIKE 'audit_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  const tables = options.tables?.length
    ? tableRows.map((r) => r.name).filter((n) => options.tables!.includes(n))
    : tableRows.map((r) => r.name);

  const results: IntrospectedColumn[] = [];

  for (const table of tables) {
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    for (const col of cols) {
      const id = `${options.datasourceId}.${table}.${col.name}`;
      if (indexed.has(id)) continue;

      const fieldRole = inferFieldRole(col.name);
      const grade = gradeColumn({
        fieldRole,
        columnName: col.name,
      });
      if (onlyL3 && grade !== "L3") continue;

      results.push({
        table,
        column: col.name,
        type: col.type || "TEXT",
        notnull: Boolean(col.notnull),
        grade,
        fieldRole,
      });
    }
  }

  return results;
}
