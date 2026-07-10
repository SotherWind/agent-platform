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
  rowFilters?: TypedPolicyPredicate[];
  maskRules?: Array<{
    table: string;
    column: string;
    strategy: "deny" | "hash" | "partial";
  }>;
}

/** 开发/demo 默认权限：允许全部 demo 数据源 */
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
  };
}
