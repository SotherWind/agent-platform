import type { FieldRole } from "./types.js";

export type ColumnGrade = "L1" | "L2" | "L3";

export interface GradeColumnInput {
  fieldRole?: FieldRole;
  sensitivity?: "normal" | "pii" | "sensitive";
  tags?: string[];
  columnName?: string;
}

const L1_ROLES = new Set<FieldRole>([
  "metric",
  "time_key",
  "join_key",
  "policy_key",
]);

const L2_ROLES = new Set<FieldRole>(["dimension", "filter"]);

const L3_ROLES = new Set<FieldRole>(["internal", "deprecated", "pii", "sensitive"]);

/** L1/L2/L3 字段分级：控制向量库文档规模 */
export function gradeColumn(input: GradeColumnInput): ColumnGrade {
  if (input.sensitivity === "pii" || input.sensitivity === "sensitive") {
    return "L3";
  }
  if (input.fieldRole && L3_ROLES.has(input.fieldRole)) {
    return "L3";
  }
  if (input.fieldRole && L1_ROLES.has(input.fieldRole)) {
    return "L1";
  }
  if (input.fieldRole && L2_ROLES.has(input.fieldRole)) {
    return "L2";
  }

  const tags = (input.tags ?? []).map((t) => t.toLowerCase());
  if (tags.some((t) => /gmv|指标|金额|核心/.test(t))) {
    return "L1";
  }
  if (tags.some((t) => /状态|维度|城市|渠道/.test(t))) {
    return "L2";
  }

  const name = (input.columnName ?? "").toLowerCase();
  if (/_at$|_date$|^date$|^time$|created_at|updated_at/.test(name)) {
    return "L1";
  }
  if (/^id$|_id$/.test(name)) {
    return "L1";
  }
  if (/flag$|_flag$|internal|etl|tmp/.test(name)) {
    return "L3";
  }

  return "L2";
}

export function shouldIndexColumn(grade: ColumnGrade): boolean {
  return grade === "L1" || grade === "L2";
}

export function groupColumnsByGrade<T extends GradeColumnInput>(
  columns: T[],
): Record<ColumnGrade, T[]> {
  const out: Record<ColumnGrade, T[]> = { L1: [], L2: [], L3: [] };
  for (const col of columns) {
    out[gradeColumn(col)].push(col);
  }
  return out;
}
