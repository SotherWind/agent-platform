/** 方言族：14 种数据库产品映射到 5～6 种 SQL 方言族 */
export type DialectFamily =
  | "mysql"
  | "postgresql"
  | "oracle"
  | "tsql"
  | "db2"
  | "hana"
  | "sqlite";

export type ProductType = string;

export type SupportStatus =
  | "planned"
  | "experimental"
  | "verified"
  | "production-certified";

export interface SecretReference {
  provider: "vault" | "aws-sm" | "azure-kv" | "env" | "test";
  key: string;
  version?: string;
}

export interface ResolvedSecret {
  value: string;
  expiresAt?: Date;
}

export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  /** SQLite 文件路径 */
  filePath?: string;
  secretRef?: SecretReference;
  /** PolarDB / OceanBase 兼容模式 */
  mode?: "mysql" | "oracle" | "pg";
  ssl?: boolean;
}

export interface DbCapabilities {
  supportsWindowFunctions: boolean;
  supportsLimitOffset: boolean;
  identifierQuote: '"' | "`" | "[";
  maxIdentifierLength?: number;
  paginationStyle: "limit" | "offset-fetch" | "rownum";
}

export interface DataSourceConfig {
  id: string;
  label: string;
  domain: string;
  productType: ProductType;
  dialectFamily: DialectFamily;
  connection: ConnectionConfig;
  exposedSchemas: string[];
  defaultSchema?: string;
  capabilities: DbCapabilities;
  supportStatus?: SupportStatus;
}

export interface SqlExecutionRequest {
  sql: string;
  dataSourceId: string;
  tenantId: string;
  subjectId?: string;
  sessionId?: string;
  requestId?: string;
  timeoutMs: number;
  maxRows?: number;
}

export interface ExecutionStats {
  durationMs: number;
  rowCount: number;
}

export interface ColumnMeta {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}

export interface SqlExecutor {
  execute(
    request: SqlExecutionRequest,
    signal: AbortSignal,
  ): Promise<import("../entities.js").ExecutionResult>;
  explain?(sql: string): Promise<string>;
  cancel?(queryId: string): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
  listTables?(schema?: string): Promise<string[]>;
  listColumns?(table: string, schema?: string): Promise<ColumnMeta[]>;
}

/** SQLite demo 默认 capabilities */
export const SQLITE_CAPABILITIES: DbCapabilities = {
  supportsWindowFunctions: true,
  supportsLimitOffset: true,
  identifierQuote: '"',
  paginationStyle: "limit",
};

/** demo/test 用 SQLite 数据源配置 */
export function createSqliteDataSourceConfig(
  id: string,
  filePath: string,
): DataSourceConfig {
  return {
    id,
    label: id,
    domain: "retail",
    productType: "SQLite",
    dialectFamily: "sqlite",
    connection: { filePath },
    exposedSchemas: ["main"],
    defaultSchema: "main",
    capabilities: SQLITE_CAPABILITIES,
    supportStatus: "verified",
  };
}
