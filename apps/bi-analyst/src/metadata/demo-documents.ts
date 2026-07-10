import type { SchemaDocument } from "./types.js";
import { InMemorySchemaRetriever } from "./retriever.js";

/** Phase 1 demo 元数据（附录 A） */
export const DEMO_SCHEMA_DOCUMENTS: SchemaDocument[] = [
  {
    id: "datasource:ecommerce_sqlite",
    docType: "datasource",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    reviewStatus: "approved",
    content: `# 数据源：电商 Demo (SQLite)

## 说明
本地 SQLite 电商 demo，包含 users 用户表与 orders 订单表。
适用于零售领域订单、用户地域分析。`,
  },
  {
    id: "ecommerce_sqlite.users",
    docType: "table",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    reviewStatus: "approved",
    content: `# 表：users

## 说明
用户信息表，包含姓名、城市等维度字段。`,
  },
  {
    id: "ecommerce_sqlite.orders",
    docType: "table",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "orders",
    reviewStatus: "approved",
    content: `# 表：orders

## 说明
订单事实表，关联 users.id，含金额、状态、下单时间。`,
  },
  {
    id: "ecommerce_sqlite.users.id",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    column: "id",
    fieldRole: "join_key",
    reviewStatus: "approved",
    content: `# 字段：users.id
dataType: INTEGER

## 业务含义
用户主键，orders.user_id 外键关联此字段。`,
  },
  {
    id: "ecommerce_sqlite.users.name",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    column: "name",
    fieldRole: "dimension",
    reviewStatus: "approved",
    content: `# 字段：users.name
dataType: TEXT

## 业务含义
用户姓名。`,
  },
  {
    id: "ecommerce_sqlite.users.city",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    column: "city",
    fieldRole: "dimension",
    tags: ["城市", "地域", "北京", "上海"],
    reviewStatus: "approved",
    content: `# 字段：users.city
dataType: TEXT

## 业务含义
用户所在城市，常用于地域分析过滤，如「北京用户」。`,
  },
  {
    id: "ecommerce_sqlite.users.created_at",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "users",
    column: "created_at",
    fieldRole: "time_key",
    reviewStatus: "approved",
    content: `# 字段：users.created_at
dataType: TEXT

## 业务含义
用户注册时间。`,
  },
  {
    id: "ecommerce_sqlite.orders.user_id",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "orders",
    column: "user_id",
    fieldRole: "join_key",
    reviewStatus: "approved",
    content: `# 字段：orders.user_id
dataType: INTEGER

## 业务含义
关联 users.id 的外键。`,
  },
  {
    id: "ecommerce_sqlite.orders.amount",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "orders",
    column: "amount",
    fieldRole: "metric",
    tags: ["GMV", "金额", "总额"],
    reviewStatus: "approved",
    content: `# 字段：orders.amount
dataType: REAL

## 业务含义
订单金额，统计订单总额时使用 SUM(amount)。`,
  },
  {
    id: "ecommerce_sqlite.orders.status",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "orders",
    column: "status",
    fieldRole: "filter",
    reviewStatus: "approved",
    content: `# 字段：orders.status
dataType: TEXT

## 业务含义
订单状态：paid、shipped、pending、cancelled 等。`,
  },
  {
    id: "ecommerce_sqlite.orders.created_at",
    docType: "column",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "orders",
    column: "created_at",
    fieldRole: "time_key",
    reviewStatus: "approved",
    content: `# 字段：orders.created_at
dataType: TEXT

## 业务含义
下单时间，时间范围分析使用此字段。`,
  },
  {
    id: "ecommerce_sqlite.orders→users",
    docType: "relation",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    table: "orders",
    reviewStatus: "approved",
    content: `# 关系：orders.user_id → users.id

## 说明
orders 多对一关联 users，JOIN ON orders.user_id = users.id`,
  },
  {
    id: "metric:order_total_amount",
    docType: "metric",
    datasourceId: "ecommerce_sqlite",
    domain: "retail",
    dialectFamily: "sqlite",
    reviewStatus: "approved",
    content: `# 指标：订单总额

## 口径
SUM(orders.amount)，可按 users.city 分组。`,
  },
];

export function createDemoRetriever() {
  return new InMemorySchemaRetriever(DEMO_SCHEMA_DOCUMENTS);
}
