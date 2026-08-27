/** 受限、可参数绑定的行级过滤谓词（禁止任意 SQL 字符串） */
export interface TypedPolicyPredicate {
  table: string;
  column: string;
  operator: "=" | "in" | "not_in";
  /** 参数占位符绑定值，禁止字符串插值 */
  values: (string | number)[];
}

export interface AccessPolicy {
  subjectId: string;
  tenantId: string;
  policyVersion: string;
  roles: string[];
  allowedDataSourceIds: string[];
  allowedSchemas?: string[];
  allowedTables?: string[];
  deniedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  deniedColumns?: Record<string, string[]>;
  minAggregationCount?: number;
  historyRetentionDays?: number;
  exportControls?: {
    requireApproval?: boolean;
    approvalRowThreshold?: number;
    sensitiveColumns?: string[];
  };
  rowFilters?: TypedPolicyPredicate[];
  maskRules?: Array<{
    table: string;
    column: string;
    strategy: "deny" | "hash" | "partial";
  }>;
}

/** 开发/demo 默认权限：允许 demo 表，不强制列白名单以兼容自由 SQL 原型路径 */
export function createDefaultAccessPolicy(
  principal: { subjectId: string; tenantId: string; roles?: string[] },
  allowedDataSourceIds: string[] = ["ecommerce_sqlite", "default", "test"],
): AccessPolicy {
  return {
    subjectId: principal.subjectId,
    tenantId: principal.tenantId,
    policyVersion: "1",
    roles: principal.roles ?? ["analyst"],
    allowedDataSourceIds,
    allowedTables: ["users", "orders"],
  };
}
