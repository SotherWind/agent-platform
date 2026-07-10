import type { DialectFamily } from "../datasource/types.js";

export type SchemaDocType =
  | "datasource"
  | "table"
  | "column"
  | "column_group"
  | "relation"
  | "metric"
  | "qa_pair";

export type ReviewStatus = "draft" | "pending" | "approved" | "rejected";

export type FieldRole =
  | "metric"
  | "dimension"
  | "filter"
  | "join_key"
  | "time_key"
  | "policy_key"
  | "pii"
  | "sensitive"
  | "deprecated"
  | "internal";

export interface SchemaDocument {
  id: string;
  docType: SchemaDocType;
  content: string;
  datasourceId: string;
  domain: string;
  dialectFamily: DialectFamily;
  schema?: string;
  table?: string;
  column?: string;
  tags?: string[];
  sensitivity?: "normal" | "pii" | "sensitive";
  fieldRole?: FieldRole;
  schemaVersion?: string;
  indexedAt?: string;
  sourceUpdatedAt?: string;
  contentHash?: string;
  embeddingModelVersion?: string;
  reviewStatus?: ReviewStatus;
  /** tombstone 标记：true 时不可检索 */
  deleted?: boolean;
}

export type ColumnReason =
  | "matched"
  | "join_key"
  | "time_key"
  | "metric_dependency"
  | "policy"
  | "fallback";

export interface RetrievedSchema {
  datasourceId: string;
  dialectFamily: DialectFamily;
  tables: Array<{
    schema?: string;
    name: string;
    columns: Array<{
      name: string;
      type: string;
      description?: string;
      reason: ColumnReason;
    }>;
    omittedColumnCount?: number;
  }>;
  joins?: Array<{
    left: string;
    right: string;
    type: "one_to_many" | "many_to_one" | "many_to_many";
  }>;
  hints: string[];
  columnReasons?: Record<string, ColumnReason>;
}
