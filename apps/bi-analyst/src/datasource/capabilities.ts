import type { DbCapabilities, DialectFamily, ProductType, SupportStatus } from "./types.js";

/** 各方言族默认能力 */
export const DIALECT_CAPABILITIES: Record<DialectFamily, DbCapabilities> = {
  sqlite: {
    supportsWindowFunctions: true,
    supportsLimitOffset: true,
    identifierQuote: '"',
    paginationStyle: "limit",
  },
  mysql: {
    supportsWindowFunctions: true,
    supportsLimitOffset: true,
    identifierQuote: "`",
    paginationStyle: "limit",
    maxIdentifierLength: 64,
  },
  postgresql: {
    supportsWindowFunctions: true,
    supportsLimitOffset: true,
    identifierQuote: '"',
    paginationStyle: "limit",
  },
  oracle: {
    supportsWindowFunctions: true,
    supportsLimitOffset: false,
    identifierQuote: '"',
    paginationStyle: "rownum",
    maxIdentifierLength: 128,
  },
  tsql: {
    supportsWindowFunctions: true,
    supportsLimitOffset: true,
    identifierQuote: "[",
    paginationStyle: "offset-fetch",
  },
  db2: {
    supportsWindowFunctions: true,
    supportsLimitOffset: true,
    identifierQuote: '"',
    paginationStyle: "limit",
  },
  hana: {
    supportsWindowFunctions: true,
    supportsLimitOffset: true,
    identifierQuote: '"',
    paginationStyle: "limit",
  },
};

export function resolveCapabilities(
  dialectFamily: DialectFamily,
  override?: Partial<DbCapabilities>,
): DbCapabilities {
  return {
    ...DIALECT_CAPABILITIES[dialectFamily],
    ...override,
  };
}

/** 产品类型 → 方言族（附录 B） */
const PRODUCT_DIALECT_MAP: Record<string, DialectFamily> = {
  SQLite: "sqlite",
  Mysql: "mysql",
  MySQL: "mysql",
  MariaDB: "mysql",
  DRDS: "mysql",
  "PolarDB(MySQL)": "mysql",
  PolarDB_MySQL: "mysql",
  HybridDB_MySQL: "mysql",
  "OceanBase(MySQL)": "mysql",
  ApsaraDB_OceanBase: "mysql",
  PostGreSQL: "postgresql",
  PostgreSQL: "postgresql",
  AnalyticDB_PostgreSQL: "postgresql",
  Oracle: "oracle",
  "PolarDB-O": "oracle",
  PolarDB_O: "oracle",
  DM: "oracle",
  "OceanBase(Oracle)": "oracle",
  SQLServer: "tsql",
  DB2: "db2",
  SAP_HANA: "hana",
};

export function mapProductToDialect(productType: ProductType): DialectFamily {
  const mapped = PRODUCT_DIALECT_MAP[productType];
  if (!mapped) {
    throw new Error(`未知 productType: ${productType}`);
  }
  return mapped;
}

/** 产品支持状态登记（Phase D 认证清单） */
export const PRODUCT_SUPPORT_STATUS: Record<string, SupportStatus> = {
  SQLite: "verified",
  MySQL: "experimental",
  /** 复用 mysql 方言族 + MysqlExecutor；Docker live 端口 3307 */
  MariaDB: "experimental",
  PostgreSQL: "experimental",
  /** 可注入 OracleExecutor；可选 oracledb；无 Docker live */
  Oracle: "experimental",
  /** 可注入 SqlServerExecutor；可选 tedious；无 Docker live */
  SQLServer: "experimental",
  DM: "planned",
  DRDS: "planned",
  PolarDB_MySQL: "planned",
  PolarDB_O: "planned",
  HybridDB_MySQL: "planned",
  AnalyticDB_PostgreSQL: "planned",
  SAP_HANA: "planned",
  DB2: "planned",
  ApsaraDB_OceanBase: "planned",
};

export function isAllowedInProduction(status: SupportStatus | undefined): boolean {
  return status === "production-certified";
}

export function assertExecutableSupportStatus(
  status: SupportStatus | undefined,
  environment: string,
): void {
  if (environment === "production") {
    if (!isAllowedInProduction(status)) {
      throw new Error(
        `生产环境仅允许 production-certified 产品（当前: ${status ?? "undefined"}）`,
      );
    }
  }
  if (environment === "staging" && status === "planned") {
    throw new Error("staging ����ʹ�� planned ����Դ");
  }
}
