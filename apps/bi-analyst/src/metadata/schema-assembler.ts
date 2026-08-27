import type {
  ColumnReason,
  RetrievedSchema,
  SchemaDocument,
} from "./types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import type { DialectFamily } from "../datasource/types.js";

const SENSITIVE_ROLES = new Set(["pii", "sensitive"]);
const MAX_COLUMNS_PER_TABLE = 40;

export interface AssembleSchemaOptions {
  datasourceId: string;
  dialectFamily: DialectFamily;
  documents: SchemaDocument[];
  policy?: AccessPolicy | null;
  matchedColumnIds?: Set<string>;
}

/** 将检索文档组装为精简 schema，排除敏感字段并补齐 join/time/policy 字段 */
export function assembleSchema(
  options: AssembleSchemaOptions,
): RetrievedSchema {
  const { documents, policy, datasourceId, dialectFamily } = options;
  const matchedIds =
    options.matchedColumnIds ??
    new Set(
      documents
        .filter((d) => d.docType === "column")
        .map((d) => columnKey(d)),
    );

  const tableDocs = documents.filter((d) => d.docType === "table");
  const columnDocs = documents.filter(
    (d) => d.docType === "column" || d.docType === "column_group",
  );
  const relationDocs = documents.filter((d) => d.docType === "relation");
  const metricDocs = documents.filter((d) => d.docType === "metric");

  const hints: string[] = [];
  for (const m of metricDocs) {
    hints.push(m.content.split("\n")[0]?.replace(/^#+\s*/, "") ?? m.content);
  }

  const joins = relationDocs.map((r) => {
    const left = r.content.match(/(\w+\.\w+)\s*→/)?.[1] ?? "";
    const right = r.content.match(/→\s*(\w+\.\w+)/)?.[1] ?? "";
    return {
      left,
      right,
      type: "many_to_one" as const,
    };
  });

  const tablesMap = new Map<
    string,
    {
      schema?: string;
      name: string;
      columns: Map<
        string,
        { name: string; type: string; description?: string; reason: ColumnReason }
      >;
      totalKnownColumns: number;
    }
  >();

  for (const t of tableDocs) {
    const key = t.table!;
    if (policy?.deniedTables?.includes(key)) continue;
    if (policy?.allowedTables?.length && !policy.allowedTables.includes(key)) {
      continue;
    }
    tablesMap.set(key, {
      schema: t.schema,
      name: key,
      columns: new Map(),
      totalKnownColumns: 0,
    });
  }

  for (const c of columnDocs) {
    if (!c.table || !c.column) continue;
    if (policy?.deniedTables?.includes(c.table)) continue;
    if (
      policy?.allowedTables?.length &&
      !policy.allowedTables.includes(c.table)
    ) {
      continue;
    }
    if (isSensitive(c, policy)) continue;
    if (isDeniedColumn(c, policy)) continue;

    let table = tablesMap.get(c.table);
    if (!table) {
      table = {
        schema: c.schema,
        name: c.table,
        columns: new Map(),
        totalKnownColumns: 0,
      };
      tablesMap.set(c.table, table);
    }

    table.totalKnownColumns++;
    const reason = inferColumnReason(c, matchedIds);
    table.columns.set(c.column, {
      name: c.column,
      type: extractDataType(c),
      description: extractDescription(c),
      reason,
    });
  }

  // 补齐 join key / time key / policy key
  for (const c of columnDocs) {
    if (!c.table || !c.column || isSensitive(c, policy)) continue;
    const table = tablesMap.get(c.table);
    if (!table) continue;

    const role = c.fieldRole;
    if (
      role === "join_key" ||
      role === "time_key" ||
      role === "policy_key" ||
      role === "metric"
    ) {
      if (!table.columns.has(c.column)) {
        table.columns.set(c.column, {
          name: c.column,
          type: extractDataType(c),
          description: extractDescription(c),
          reason: role === "join_key"
            ? "join_key"
            : role === "time_key"
              ? "time_key"
              : role === "policy_key"
                ? "policy"
                : "metric_dependency",
        });
      }
    }
  }

  const columnReasons: Record<string, ColumnReason> = {};
  const tables = [...tablesMap.values()].map((t) => {
    let cols = [...t.columns.values()];
    const omitted =
      t.totalKnownColumns > cols.length
        ? t.totalKnownColumns - cols.length
        : undefined;

    if (cols.length > MAX_COLUMNS_PER_TABLE) {
      cols = cols.slice(0, MAX_COLUMNS_PER_TABLE);
    }

    for (const col of cols) {
      columnReasons[`${t.name}.${col.name}`] = col.reason;
    }

    return {
      schema: t.schema,
      name: t.name,
      columns: cols,
      omittedColumnCount:
        omitted ??
        (t.totalKnownColumns > MAX_COLUMNS_PER_TABLE
          ? t.totalKnownColumns - MAX_COLUMNS_PER_TABLE
          : undefined),
    };
  });

  return {
    datasourceId,
    dialectFamily,
    tables,
    joins: joins.length > 0 ? joins : undefined,
    hints,
    columnReasons,
  };
}

function columnKey(doc: SchemaDocument): string {
  return `${doc.table}.${doc.column}`;
}

function isSensitive(
  doc: SchemaDocument,
  policy?: AccessPolicy | null,
): boolean {
  if (doc.sensitivity === "pii" || doc.sensitivity === "sensitive") {
    return true;
  }
  if (doc.fieldRole && SENSITIVE_ROLES.has(doc.fieldRole)) {
    return true;
  }
  if (policy?.deniedColumns && doc.table) {
    const denied = policy.deniedColumns[doc.table];
    if (denied?.includes(doc.column!)) return true;
  }
  return false;
}

function isDeniedColumn(
  doc: SchemaDocument,
  policy?: AccessPolicy | null,
): boolean {
  if (!policy?.allowedColumns || !doc.table) return false;
  const allowed = policy.allowedColumns[doc.table];
  if (!allowed) return false;
  return !allowed.includes(doc.column!);
}

function inferColumnReason(
  doc: SchemaDocument,
  matchedIds: Set<string>,
): ColumnReason {
  if (matchedIds.has(columnKey(doc))) return "matched";
  if (doc.fieldRole === "join_key") return "join_key";
  if (doc.fieldRole === "time_key") return "time_key";
  if (doc.fieldRole === "policy_key") return "policy";
  if (doc.fieldRole === "metric") return "metric_dependency";
  return "fallback";
}

function extractDataType(doc: SchemaDocument): string {
  const match = doc.content.match(/dataType:\s*(\S+)/i);
  return match?.[1] ?? "TEXT";
}

function extractDescription(doc: SchemaDocument): string | undefined {
  const biz = doc.content.match(/## 业务含义\s*\n([\s\S]*?)(?=\n##|$)/);
  return biz?.[1]?.trim().split("\n")[0];
}
