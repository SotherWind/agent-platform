# BI Analyst 数据库产品支持状态

> 更新日期：2026-07-28（对齐 ENTERPRISE-PLAN **v1.18**）  
> 本轮范围：仅单机部署；SQLite、MySQL、MariaDB、PostgreSQL 的单机 L1～L4 主路径已完成。  
> `production-certified` 仅是未来云 staging/production 认证状态，不作为本轮单机完成条件。

## 单机优先

| 层级 | 产品 / 能力 | 说明 |
|------|-------------|------|
| 必保 | SQLite、MySQL、MariaDB、PostgreSQL | Docker Compose live；单机 L1～L4 验收 |
| 可选 | Oracle、SQL Server | experimental；本轮不要求真实 live，不挡单机主路径 |
| 本轮不纳入 | AnalyticDB / PolarDB / OceanBase / DB2 / HANA 等 | `planned` |
| 本轮不纳入 | 云、集群、`production-certified` | 非单机部署范围 |

单机 L4 开关见 `.env.example`「单机 staging」与 `SINGLE-MACHINE-STAGING-CHECKLIST.md`。

## 本地运维脚本

| 脚本 | 用途 |
|------|------|
| `pnpm docker:up` | 启动 MySQL + MariaDB + PostgreSQL demo 库 |
| `pnpm test:live-db` | Executor / 扫描 / TLS 联调（含 MariaDB:3307） |
| `pnpm sync:metadata` | SQLite 扫描 → `runMetadataSync`（可加 `QDRANT_URL`） |
| `pnpm sync:metadata:live -- --dry-run/--approve` | MySQL/PG 业务 schema 预览或显式批准后重建 Qdrant |
| `pnpm sync:metadata:schedule` | 进程内间隔调度（`METADATA_SYNC_*`） |
| `pnpm verify:routing` | 多数据源路由 Top-1 门禁（20 条 golden cases，阈值 95%） |
| `pnpm verify:llm-eval` | Text-to-SQL 离线 golden 门禁（5 个 certified metrics） |
| `pnpm verify:dialect-cert` | 单机方言认证门禁（`localPass=true`；云信息仅作后续参考） |
| `pnpm test:e2e:staging` | 模型与 alias 回滚演练 |
| `pnpm start:staging` | 同一 `dist` + `APP_ENV=staging`（单机加 `BI_SINGLE_MACHINE_STAGING=1`） |

## 持久化适配器（本地 / quasi-production）

| 组件 | development | test | quasi-production / 单机 staging |
|------|-------------|------|--------------------------------|
| 审计 | `SqliteAuditStore` + TTL | `InMemoryAuditStore` | `PostgresAuditStore`（`AUDIT_DATABASE_URL`）+ `AUDIT_RETENTION_DAYS` |
| 查询历史 | `SqliteQueryHistoryStore` | `InMemoryQueryHistoryStore` | `PostgresQueryHistoryStore`（`HISTORY_DATABASE_URL` / 复用审计库） |
| Checkpointer | `SqliteCheckpointSaver` | `MemorySaver` | `PostgresCheckpointSaver`（`CHECKPOINT_DATABASE_URL` / 复用） |
| 查询缓存 | 内存；可选 Redis L2（`REDIS_URL`） | 内存 | Redis L1+L2（`REDIS_URL`）或内存 |
| 密钥 | `EnvSecretProvider` | `TestSecretProvider` | Vault / AWS SM / Azure KV（可 Composite）+ `AuditingSecretProvider`；缺省 fail closed；单机可 `BI_ALLOW_ENV_SECRETS` |
| 策略 | File / InMemory / `HttpPolicyProvider` | InMemory | `POLICY_SERVICE_URL` 或 `POLICY_CONFIG_PATH` |
| 身份 | HeaderAuth | 固定测试 Principal | JWT/JWKS / OIDC / `BI_STAGING_MOCK_AUTH` |

## 产品支持矩阵

| productType | dialectFamily | supportStatus | 备注 |
|-------------|---------------|---------------|------|
| SQLite | sqlite | verified | development/test 可自动 seed；部署产物仅只读挂载运维提供的现有 DB，不内置 demo DB |
| MySQL | mysql | experimental（单机已验收） | Docker live 全矩阵；云 `production-certified` 不在本轮范围 |
| MariaDB | mysql | experimental（单机已验收） | 复用 MysqlExecutor；Docker live（3307） |
| PostgreSQL | postgresql | experimental（单机已验收） | Docker live 同 MySQL 级别；云 `production-certified` 不在本轮范围 |
| AnalyticDB_PostgreSQL | postgresql | planned | 单机不做 |
| Oracle | oracle | experimental（单机可选） | 可注入客户端 / 可选 `oracledb`；`EXPLAIN PLAN` + `DBMS_XPLAN` 成本门禁已实现；真实 live 不在本轮范围 |
| PolarDB_O / DM | oracle | planned | 单机不做 |
| SQLServer | tsql | experimental（单机可选） | 可注入 / 可选 `tedious`；`SHOWPLAN_TEXT` 成本门禁已实现；真实 live 不在本轮范围 |
| DB2 | db2 | planned | stub |
| SAP_HANA | hana | planned | stub |
| DRDS / PolarDB_MySQL / HybridDB_MySQL / OceanBase | mysql | planned | mode 字段区分兼容模式 |

## 认证检查清单

### 本地 / 单机可证明（已完成）

- [x] AST 方言校验拒绝 DML；多方言 conformance（oracle/tsql AST 暂借 PG 解析器）
- [x] statement cancellation / 超时；连接池 / 熔断；只读事务；TLS 硬化
- [x] 行级策略 live（MySQL/PG/MariaDB）；TLS+CA；MySQL mTLS
- [x] MySQL/PG EXPLAIN 成本门禁；多方言 LogicalQuery 编译
- [x] ExecutorRegistry；MariaDB Docker live；Oracle/SQLServer experimental Executor
- [x] 结构化澄清 `clarificationChoice`；staging E2E 回滚演练
- [x] Postgres 审计 / 历史 / checkpointer；Redis L1+L2；元数据同步调度
- [x] Vault / AWS SM / Azure KV + 密钥轮换审计；`HttpPolicyProvider`
- [x] `pnpm verify:dialect-cert`（本地门禁）
- [x] 完整单机门禁：unit **309 通过 / 12 跳过**（服务开启时 309/9）、contract **24**、security **25**、evaluation **4**、`test:integration:local` **16/16**、service integration **22**、local E2E **6**、staging rollout E2E **3**、artifact **108 文件**、schema eval **4/4**、路由 **20/20**、离线 LLM eval **5/5**、`typecheck` / `build` 通过（live LLM 按配置跳过）

### 单机优先已收口（v1.18）

- [x] L4 单机 staging Profile：`APP_ENV=staging` + mock JWKS + InMemory/Qdrant + Registry；同一 `dist`
- [x] live 多库 analyze：`BI_ATTACH_LIVE_DATASOURCES=1`（staging-acc / docker compose）
- [x] 验收断言：`meta.requestId` / `meta.traceId` + 审计可查
- [x] SSO OIDC 发现 + 会话绑定（本机 stub）
- [x] 审计 TTL（`AUDIT_RETENTION_DAYS`）
- [x] 远端 L4：同一 production artifact 构建；health `staging` + `liveDataSourceIds`；MySQL/PG analyze；audit 非空；验收资源清理
- [x] 本地运行态 L4：Qdrant `6333` + MySQL `3306` + PostgreSQL `5432` 已启动；health / mock-token / analyze / audit / forged identity 全部实测通过；Qdrant 已索引 13 条 demo + 24 条 approved live 元数据
- [x] 本地真实模型复验：SQLite/MySQL/PG 真实模型 RAG 均 `cacheHit=false`；schema 显式批准后成功召回；模型生成 SQL 并由三个 executor 执行成功（各 1 行）；live LLM gate 仍按配置作为可选门禁
- [x] production artifact 隔离：deployable composition root 不引用 seed/demo/test helper；`dist` 108 文件和 staging image 均通过边界检查
- [x] 指标与路由门禁：5 个 certified metrics 确定性编译；Text-to-SQL 5/5；多数据源路由 20/20，Top-1 100%（阈值 95%）
- [x] 单机 CI：`verify`、`integration-services`、`staging-image` 三段完整门禁已落地；最终 job 启动 production image 验证 L4 health、MySQL/PG analyze、401 身份拒绝与审计

### 已完成的本地能力（含 Docker 真实库 live）

- [x] Oracle / SQL Server Executor 合约、方言分页、占位符、DML 拒绝和注入客户端单测
- [x] Oracle `EXPLAIN PLAN` + `DBMS_XPLAN.DISPLAY` / SQL Server `SHOWPLAN_TEXT` 成本门禁代码与单测
- [x] 导出 CSV 注入防护、水印、TTL、AES 加密、审批/拒绝/一次性下载
- [x] 大结果行数、列数、UTF-8 字节数降级，并在答语与 `meta.resultPolicy` 中提示原因
- [x] SSE lifecycle、heartbeat、终止 `done`、错误/取消状态、客户端断开取消和必要 headers

### 单机部署结论（本轮）

- [x] 单机主路径已完成：SQLite + MySQL/MariaDB/PostgreSQL live、认证/策略、Schema RAG、LogicalQuery/metrics、ResultPolicy、审计/历史、SSE、导出、限流和 L4 staging 均已验收。
- [x] 单机必做门禁已完成：本地完整门禁与远端 L4 结果见上方记录和 `SINGLE-MACHINE-STAGING-CHECKLIST.md`。

### 本轮不纳入的范围

| 范围 | 状态 | 说明 |
|------|------|------|
| Oracle / SQL Server 真实 live 矩阵 | 单机可选扩展 | 需要镜像/许可；Executor、编译、成本门禁和注入客户端测试已完成，不阻塞单机主路径 |
| 云 staging、云托管库 TLS/mTLS/网络、云容量/故障/SLO | 暂缓 | 非单机部署任务 |
| `production-certified` 晋级签字 | 暂缓 | 单机允许 `verified` / `experimental`，本轮不声明云生产认证 |
| K8s/集群、多实例 checkpointer HA、跨云密钥 HA | 暂缓 | 分布式部署任务，按当前范围不实施 |

本地门禁：`pnpm verify:dialect-cert`（`localPass=true`；云信息仅作后续参考）。

## 本地 Docker 联调

```bash
pnpm docker:certs
pnpm docker:up
pnpm test:live-db
pnpm sync:metadata
# 预览 live schema（不写入 Qdrant）
pnpm sync:metadata:live -- --dry-run
# 显式批准 users/orders 并原子切换 metadata alias
pnpm sync:metadata:live -- --approve
pnpm verify:dialect-cert

# 单机 L4（同一 dist）示例：
# APP_ENV=staging BI_SINGLE_MACHINE_STAGING=1 BI_STAGING_MOCK_AUTH=1 \
#   BI_ALLOW_INMEMORY_RETRIEVER=1 BI_ATTACH_LIVE_DATASOURCES=1 \
#   DATASOURCE_REGISTRY_PATH=config/datasources.staging-acc.yaml \
#   POLICY_CONFIG_PATH=config/policies.staging-acc.json \
#   AUDIT_RETENTION_DAYS=7 pnpm start:staging

# live 挂载（dev）：
# BI_ATTACH_LIVE_DATASOURCES=1 BI_MARIADB_HOST=127.0.0.1 BI_MARIADB_PORT=3307 pnpm dev

pnpm docker:down
pnpm test:e2e:staging
```

远端验收：`apps/bi-analyst/docker/staging-acc/`（`pack-and-deploy.ps1` / `remote-accept.sh`）。

## Oracle / SQL Server 能力边界（experimental）

| 能力 | 状态 |
|------|------|
| LogicalQuery 方言编译 + AST 拒 DML | ✅ |
| 可注入客户端 + 单测 | ✅ |
| 可选驱动 `oracledb` / `tedious` | ✅ 首步 |
| Docker live | 本轮不纳入（需要镜像/许可与真实连接证据） |
| EXPLAIN·SHOWPLAN 成本门禁 | ✅（代码与注入客户端单测） |
| production-certified | 本轮不纳入（云运维范围） |

## 路由边界

- 单查询路由到**单个**数据源；跨源 join 返回 `cross_source_query` 澄清。
