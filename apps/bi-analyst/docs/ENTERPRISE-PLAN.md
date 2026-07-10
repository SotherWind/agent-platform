# BI Analyst 企业级演进计划

> 版本：v1.0  
> 日期：2026-07-10  
> 状态：规划中

本文档基于当前 `bi-analyst` 原型（Text-to-SQL + 图表 + SQL 自愈重试 + Schema RAG/安全治理原型），描述向**企业级、跨领域、多数据源** BI Agent 演进的完整计划。

本文档中的能力状态统一使用以下术语：

- `prototype`：已有可运行代码和单元测试，但使用 demo/static 装配，不具备生产闭环
- `verified`：通过 contract/integration/E2E 和安全验收，可在受控环境使用
- `production-certified`：通过容量、故障、权限、审计、回滚和真实数据库认证，可用于生产关键查询

---

## 1. 现状摘要

### 1.1 当前能力矩阵

| 模块 | 当前状态 | 已实现 | 企业级缺口 |
|------|----------|--------|------------|
| 工作流 | `prototype` | LangGraph：`planner → schemaRag → sqlGenerator → codeInterpreter → chartFormatter`，支持 SQL 自愈重试 | 缺可信 RequestContext、指标/澄清路由、持久化会话和完整 trace |
| Text-to-SQL | `prototype` | LLM 生成只读 SQL，当前主要限制 SQLite 语法 | 缺逻辑查询中间层、方言编译、模型/Prompt 版本治理和真实库评测 |
| 数据执行 | `prototype` | `SqlExecutor` contract + SQLite executor，支持行数限制、超时接口和审计调用 | 仅 SQLite；取消、连接池、只读事务、成本控制和故障隔离未生产认证 |
| SQL 安全 | `prototype` | 只读/单语句/危险语句/表 allowlist 校验 | 当前不是完整方言 AST；缺函数、catalog、子查询、UNION、成本和作用域安全闭环 |
| Schema RAG | `prototype` | InMemory demo retriever、分层检索、SchemaAssembler、字段裁剪和敏感字段过滤 | 缺 Qdrant、索引版本、增量同步、tombstone、alias 回滚和召回评测 |
| 数据源路由 | `prototype` | 根据会话/权限允许列表/检索结果选择单数据源 | 仍是启发式选源；缺 Registry、置信度、冲突澄清、路由评测和多源认证 |
| 身份与权限 | `prototype` | `AuthenticatedPrincipal`、请求体身份防伪、session ownership、静态 `AccessPolicy` | Agent 默认装配仍可回退 test principal；缺真实认证、策略服务、版本和缓存失效 |
| 结果防泄漏 | `prototype` | 列 deny/mask、行列/响应体限制、最小聚合人数 | 缺类型感知掩码、防推断、导出策略和图表/narrative 二次检查 |
| 审计 | `prototype` | `AuditLogger` 接口和 console logger | 缺持久化、查询、保留策略、字段分级和端到端 traceId |
| 可视化 | `prototype` | bar / line / pie / scatter / table → ECharts option | 缺可信 narrative、数据新鲜度提示、无障碍和大结果降级 |
| 测试 | `prototype` | 当前单元测试基线 60 通过，集成测试可选运行 | 缺 typecheck/build/contract/local E2E/artifact verify 和真实模型 evaluation 门禁 |

### 1.2 主要缺口

- 当前能力多数停留在 demo/static `prototype`，尚未形成 API → 认证 → 权限 → 检索 → SQL → 执行 → 结果策略 → 审计的生产闭环
- 核心 Agent 仍存在 `createTestPrincipal()`、默认 tenant/dataSource 和 `createDemoRetriever()` 回退，生产环境尚未 fail closed
- `AgentState` 与可信身份/权限运行时上下文混合，持久化恢复时存在信任边界不清的问题
- 仍以 LLM 直接生成 SQL 为主，缺少可校验的 `LogicalQuery` / query plan 中间层
- 仅 SQLite executor 可用，无真实 Registry、SecretProvider、连接池和多数据库 production certification
- SQL Validator 仍是原型校验，缺方言 AST、对象/函数 allowlist、作用域约束、成本估算和只读事务闭环
- Schema RAG 仍使用 demo 文档，无 Qdrant 版本化索引、增量扫描、失效回滚和离线召回评测
- 无语义层 / 指标层，核心 KPI 的口径、时间、币种、单位和 fanout 无法统一证明
- 缺数据质量与 freshness、权限感知缓存、结构化澄清、异步导出和模型/Prompt 治理
- 测试脚本和发布门禁尚未闭环，真实集成测试默认跳过

### 1.3 关键代码入口

```
src/agent.ts          # LangGraph 工作流
src/state.ts          # Agent 状态定义
src/auth/             # 身份与会话边界原型
src/datasource/       # Executor/Validator/DataSource 类型原型
src/metadata/         # Schema RAG 与 SchemaAssembler 原型
src/policy/           # AccessPolicy/ResultPolicy 原型
src/audit/            # 审计接口原型
src/tools/generate_sql.ts
src/tools/execute_code.ts
src/db/seed.ts        # 仅 demo/test：SQLite 种子 + getSchema
```

---

## 2. 目标架构

### 2.1 设计原则

1. **身份不可伪造**：前端业务参数只传 `{ query, sessionId? }`；`userId`、`tenantId`、roles 必须来自已验证的 JWT / SSO / API Gateway 身份上下文
2. **连接与检索分离**：向量库存业务元数据；连接密码存 Registry + 密钥系统
3. **分层暴露**：Agent 只看 ADS/DWS 主题层，不看 ODS 全量
4. **双轨查询**：核心 KPI 走语义层；长尾 ad-hoc 走 Schema RAG
5. **方言抽象**：14 种数据库产品 → 5～6 种 SQL 方言族
6. **纵深只读**：数据库只读账号 + 数据库授权 + 方言 AST 校验 + 只读事务共同保证只读，不能只依赖 prompt 或关键字判断
7. **最小上下文**：RAG 负责产出相关 schema 子集，不把宽表全字段交给 LLM
8. **治理前置**：权限、审计、错误脱敏、超时取消、行数限制、结果防泄漏从基础层开始建设
9. **权限贯穿全链路**：身份、选源、检索、SQL 生成、AST 校验、执行和结果返回均执行权限约束
10. **元数据可追溯**：元数据必须有版本、新鲜度、删除标记、审核状态和可回滚索引，不允许长期依赖手工静态快照
11. **TDD 作为交付门禁**：所有行为变更先写失败测试，再实现最小代码，最后重构；没有自动化验收测试的功能不算完成
12. **环境显式分流**：`development` / `test` 都使用本地全栈 Profile 跑通完整业务链路；`staging` / `production` 运行同一生产构建产物，未知或缺失环境必须 fail closed
13. **可信上下文与会话状态分离**：身份、权限快照、deadline、密钥和连接配置属于运行时上下文，不得作为可由模型或历史会话覆盖的普通 Graph State
14. **单源先闭环再扩多源**：先把一个真实数据源做到安全、可观测、可评测和可回滚，再扩展其他数据库产品
15. **结构化计划优先**：自然语言优先转换为可验证的 `LogicalQuery`，再编译为方言 SQL；自由 SQL 仅用于受控长尾路径
16. **数据质量可见**：回答必须携带 `dataAsOf`、时区、新鲜度和质量告警，不把过期或不完整数据包装成确定结论

### 2.2 总体架构图

```
┌─────────────────────────────────────────────────────────────┐
│  API 层：{ query, sessionId? } + AuthenticatedPrincipal      │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent 路由层                                                │
│  身份验证 → 权限过滤 → 会话校验 → 选源 → 指标/RAG             │
└──────┬──────────────────┬───────────────────────────────────┘
       ▼                  ▼
┌──────────────┐   ┌───────────────────────────────────────────┐
│  语义层       │   │  Schema RAG（Qdrant）                     │
│  metrics.yaml│   │  datasource / table / column / metric     │
└──────┬───────┘   └──────────────────┬────────────────────────┘
       ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│  数据源注册表 DataSourceRegistry                             │
│  productType + dialectFamily + connection（密钥隔离）        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  统一执行引擎 SqlExecutor（方言适配、超时、行数限制、审计）   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  图表 + 洞察 narrative                                       │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 可信运行时上下文与 Graph State 边界

请求级可信信息由 API/认证中间件和 Composition Root 构造，通过 LangGraph runtime context 或节点闭包注入，不允许从请求体、模型输出或历史 state 恢复：

```ts
interface RequestContext {
  requestId: string;
  traceId: string;
  principal: AuthenticatedPrincipal;
  sessionId?: string;
  deadlineAt: number;
  policySnapshot: AccessPolicy;
  runtimeProfile: RuntimeProfile;
  abortSignal: AbortSignal;
}
```

| 可进入 `AgentState` | 只能存在 `RequestContext` / 服务端存储 |
|---------------------|------------------------------------------|
| 用户问题、结构化澄清、候选 metric、逻辑查询、检索结果引用、图表配置 | principal、完整 AccessPolicy、secretRef/连接配置、deadline、AbortSignal、内部审计字段 |

约束：

- checkpointer 使用 `tenantId + subjectId + sessionId` 复合键，但恢复会话后必须重新认证并加载最新权限
- `policyVersion`、用户角色或数据源授权变化时，旧的路由、metadata、query plan 和结果缓存全部失效
- `staging` / `production` 缺失 principal、policy 或 runtime profile 时立即拒绝，不允许调用 test/default fallback
- Graph 节点只接收完成权限裁剪后的 metadata；密钥、连接串和原始数据库错误永不进入 LLM 上下文

### 2.4 标准请求生命周期

```text
authenticate
→ validate request/session
→ load policy snapshot
→ classify intent
→ select datasource or clarify
→ select metric/RAG path
→ retrieve authorized metadata
→ build LogicalQuery
→ compile/render dialect SQL
→ validate SQL AST + scope + cost
→ execute with deadline/cancellation
→ apply ResultPolicy
→ generate chart/narrative
→ persist trace/audit
```

每个阶段都必须声明：输入/输出 Schema、超时预算、是否可重试、错误分类、权限检查点、审计事件和降级策略。禁止使用一个覆盖全链路的无界重试；LLM、metadata、SQL 分别设置独立 retry budget。

建议统一审计事件：

- `request.accepted`、`auth.validated`、`policy.loaded`
- `datasource.selected`、`metadata.retrieved`、`metric.matched`
- `query.plan_built`、`sql.generated`、`sql.validation_rejected`、`sql.executed`
- `result.redacted`、`answer.completed`、`request.failed`

### 2.5 运行时漏斗（分层检索）

用户问题 **不** 直接在百万级字段文档里全局搜索，而是漏斗式检索：

```
Step 1  选数据源   docType=datasource，结合 principal 权限过滤  → top-1~3
Step 2  选表       docType=table，filter(datasourceId)         → top-3~5
Step 3  选字段     docType=column，filter(table IN [...])      → top-15~30
Step 4  SchemaAssembler 精简字段、补齐 join/time/policy 字段
Step 5  组装 schema JSON → generate_sql → SQL 校验 → execute → chart
```

字段很多的宽表不能全量进入 prompt。最终给 LLM 的 schema 只包含：

- 与问题强相关的指标、维度、过滤字段
- 必要主键、外键、join key
- 必要时间字段，如 `created_at` / `order_date`
- 指标口径依赖字段，如 GMV 的 `amount` / `status`
- 权限策略依赖字段，如 `tenant_id` / `org_id`
- 已授权且非敏感的字段

运行时边界：Phase D 的多数据源能力默认是**单查询路由到单个数据源**，不是跨库 join。跨源联合分析需另行建设查询编排或联邦查询层。

### 2.6 环境分流与依赖装配

使用单一环境变量 `APP_ENV` 决定运行 Profile，只允许 `development | test | staging | production`。

```typescript
type AppEnvironment = 'development' | 'test' | 'staging' | 'production';

interface RuntimeProfile {
  environment: AppEnvironment;
  isLocal: boolean;
  authProvider: AuthProvider;
  secretProvider: SecretProvider;
  dataSourceRegistry: DataSourceRegistry;
  schemaRetriever: SchemaRetriever;
  checkpointer: Checkpointer;
  auditSink: AuditSink;
}
```

本地分流条件只有一个：`APP_ENV === 'development' || APP_ENV === 'test'`。这里的“本地”只表示依赖可在开发机或 CI 自包含运行，**不表示跳过业务节点或只运行 mock 单元测试**。

`development` 与 `test` 必须经过同一条完整业务链路：

```text
HTTP API
  → 本地认证 Principal
  → 会话所有权与 AccessPolicy
  → datasourceRouter
  → metric / Schema RAG
  → SQL 生成或指标编译
  → SqlValidator
  → SqlExecutor
  → ResultPolicy
  → chart / narrative
  → audit
  → API Response
```

| 能力 | `development` 本地全栈 Profile | `test` 本地全栈 Profile | `staging` / `production` 发布 Profile |
|------|---------------------------------|----------------------------|-----------------------------------------|
| API / Agent 图 | 完整启动、支持 watch 和人工调试 | 完整启动、由测试驱动调用 API/Graph | 运行生产 `dist/` 完整链路 |
| 数据库 | 本地 SQLite，可保留开发数据 | 每用例隔离的 SQLite / 临时测试库 | Registry 中已认证的外部只读数据源 |
| Schema 检索 | InMemory 或本地 Qdrant，可热更新 | 隔离的 InMemory 或临时 Qdrant | Qdrant 集群 + version/alias/freshness |
| 密钥 | 本地受控 `env` / dev secret | 测试 SecretProvider，仅返回测试凭据 | Vault / KMS / 云 Secret Manager |
| 身份 | 本地开发认证适配器，但仍生成完整 Principal | 固定测试用户/租户，仍执行会话和权限校验 | JWT / SSO / API Gateway 验证后的 Principal |
| 会话 | MemorySaver 或本地持久化存储 | 每测试隔离并自动清理的 checkpointer | 持久化、加密、租户隔离的 checkpointer |
| 审计 | 控制台/本地文件，执行完整审计链路 | 内存测试 AuditSink，断言审计事件 | 持久化审计存储 + trace + 保留策略 |
| LLM | 可配置真实开发模型、本地模型或 deterministic adapter | 默认 deterministic adapter 保证可重复；另设真实模型评测 job | 受控模型网关、预算、超时、审计 |
| 启动方式 | `tsx` 启动完整应用，支持 watch | 测试进程启动完整应用或 Graph | TypeScript 编译为 `dist/` 后运行不可变产物 |
| demo seed | 启动时可显式初始化本地开发数据 | 每用例显式创建、seed、销毁 | 禁止打包或调用 |

`test` 使用 deterministic LLM adapter 的目的只是稳定外部不确定性，不能绕过 planner、router、retriever、validator、executor、result policy、chart 和 audit 等内部流程。真实模型行为由独立 evaluation job 覆盖。

**强制约束**：

- 环境判断只允许出现在 `src/config/` 和 Composition Root，业务节点禁止散落读取 `process.env`
- `APP_ENV` 缺失、拼写错误或出现未支持值时启动失败，不得自动降级为本地模式
- `staging` 与 `production` 一律走生产依赖和生产构建，只允许连接目标、容量和发布策略不同
- 生产 Profile 初始化失败时直接终止启动，禁止回退到 SQLite、内存检索、测试身份或本地密钥
- 本地与生产实现必须遵守同一接口，并通过同一组 contract tests，防止“本地能跑、生产语义不同”
- 构建产物不得包含 `.env`、真实密钥、demo 数据库、测试 Principal、fixture 和测试专用路由
- 配置在启动时一次性完成 Zod 校验，并输出不含密钥的配置摘要与 `configVersion`

**目标脚本约定**：

| 脚本 | 用途 |
|------|------|
| `pnpm dev` | `APP_ENV=development`，本地 Profile + watch |
| `pnpm test` | `APP_ENV=test`，运行快速 unit + contract；不替代全流程测试 |
| `pnpm test:integration:local` | 启动 test 本地全栈 Profile，从 API/Graph 跑通完整链路 |
| `pnpm test:e2e:local` | 从 HTTP 请求到响应、审计和持久化断言的本地 E2E |
| `pnpm test:integration:services` | 容器化 Qdrant / MySQL / PostgreSQL 合约测试 |
| `pnpm build` | 使用 `tsconfig.build.json` 生成 `dist/` |
| `pnpm start` | `APP_ENV=production`，只运行 `dist/` 产物 |
| `pnpm start:staging` | `APP_ENV=staging`，运行同一份 `dist/` 产物 |
| `pnpm verify:artifact` | 检查产物不含 fixture、密钥、demo DB 和测试代码 |

Windows/Linux CI 均使用跨平台环境变量工具或平台运行时配置注入，不能依赖仅适用于单一 shell 的写法。

### 2.7 TDD 测试驱动开发规范

每个需求、缺陷和安全规则必须遵循 **Red → Green → Refactor**：

1. **Red**：先提交能够复现需求或缺陷的失败测试，明确输入、预期输出和安全不变量
2. **Green**：只实现使测试通过的最小代码，不同时扩展未经测试的能力
3. **Refactor**：在所有测试持续通过的前提下消除重复、整理接口和提升可读性
4. **Regression**：线上失败、越权尝试、模型错误和方言兼容问题先沉淀为回归测试，再修复实现

**测试层次**：

| 层次 | 默认依赖 | 目标 |
|------|----------|------|
| Unit | fake / stub，无网络 | 策略、解析、AST、路由、编译器的确定性行为 |
| Contract | 同一接口的本地与生产适配器 | `SqlExecutor`、Retriever、Registry、SecretProvider 行为一致 |
| Integration Local | test 本地全栈 Profile + deterministic LLM adapter | 开发机和 CI 自包含跑通所有内部业务节点 |
| E2E Local | 完整 HTTP 应用 + 隔离本地依赖 | 从认证请求到响应、审计、会话和结果策略的全流程 |
| Integration Service | 容器化 Qdrant / MySQL / PostgreSQL | 验证真实驱动、方言、超时取消和索引生命周期 |
| E2E Staging | 生产构建产物 + staging 依赖 | 验证认证、发布配置、审计、SLO 和回滚 |
| Security / Evaluation | 攻击集 + golden dataset | 越权为 0、指标口径、检索与 Text-to-SQL 质量门槛 |

**TDD 门禁**：

- 每个 Phase 的验收项必须先映射到自动化测试 ID，再开始实现
- 单元测试不得默认访问网络、真实 LLM、生产数据库或共享 Qdrant
- 时间、随机数、UUID、模型输出、权限服务和数据库均通过依赖注入保证可重复
- 修复 bug 必须包含至少一个修复前失败、修复后通过的回归测试
- PR 必须通过 typecheck、unit、contract、integration-local、e2e-local、安全静态检查和生产构建
- 需要外部服务的测试可以独立 job 运行，但合并到主分支前必须通过
- 禁止以降低断言、删除测试、扩大 mock 范围或跳过安全用例的方式让流水线变绿
- 覆盖率只作为辅助指标；关键安全分支、策略拒绝分支和指标编译分支要求 100% 分支覆盖

---

## 3. 核心模块设计

### 3.0 可信身份与会话边界

API 不信任请求体中的 `userId`、`tenantId`、roles。身份必须由认证中间件从 JWT / SSO / API Gateway 等可信来源解析，并在进入 Agent 前形成不可由业务参数覆盖的主体对象：

```typescript
interface AuthenticatedPrincipal {
  subjectId: string;
  tenantId: string;
  roles: string[];
  claims: Record<string, unknown>;
}

interface AnalyzeRequest {
  query: string;
  sessionId?: string;
}
```

**强制约束**：

- `sessionId` 必须校验归属于当前 `tenantId + subjectId`，禁止仅凭 ID 读取历史会话
- checkpointer / cache key 必须包含 `tenantId + subjectId + sessionId`
- 每次请求重新加载或校验权限版本；角色变化后旧会话不能继续沿用旧权限
- 会话只保存逻辑上下文，不保存明文密钥、数据库连接、原始敏感结果
- 未认证、租户不匹配、会话所有权不匹配时，在调用 LLM 和检索元数据前直接拒绝

### 3.1 数据源注册表（DataSourceRegistry）

**职责**：管理连接信息、方言、暴露范围；**不入向量库**。

```typescript
interface DataSourceConfig {
  id: string;
  label: string;
  domain: string;                    // retail | finance | healthcare | general
  productType: ProductType;          // UI 配置的 14 种数据库类型
  dialectFamily: DialectFamily;      // mysql | postgresql | oracle | tsql | db2 | hana
  connection: ConnectionConfig;      // host/port/database，secretRef 指向密钥系统
  exposedSchemas: string[];          // Agent 可见 schema，如 ['ads', 'dws']
  defaultSchema?: string;
  capabilities: DbCapabilities;      // 分页、窗口函数、标识符引号等
}
```

**产品类型 → 方言族映射（示例）**：

| 方言族 | 产品 |
|--------|------|
| mysql | MySQL, MariaDB, DRDS, PolarDB(MySQL), HybridDB, OceanBase(MySQL) |
| postgresql | PostgreSQL, AnalyticDB PG |
| oracle | Oracle, PolarDB-O, 达梦 DM, OceanBase(Oracle) |
| tsql | SQL Server |
| db2 | DB2 |
| hana | SAP HANA |

PolarDB / OceanBase 等需在连接配置中增加 `mode` 字段（mysql / oracle / pg）。

方言族只负责复用通用 SQL 规则；每个产品仍需提供 capability override 和兼容性测试，不能把“映射到同一方言族”等同于“已生产支持”。产品支持状态分为 `planned | experimental | verified | production-certified`。

**密钥解析接口**：

```typescript
interface SecretReference {
  provider: 'vault' | 'aws-sm' | 'azure-kv' | 'env' | 'test';
  key: string;
  version?: string;
}

interface SecretProvider {
  resolve(ref: SecretReference): Promise<ResolvedSecret>;
}
```

- 生产环境禁止在 YAML/JSON Registry 中存储明文密码
- `env` provider 仅允许本地开发；生产应接 Vault / KMS / 云 Secret Manager
- 必须支持密钥轮换、连接池重建、TLS 证书校验和密钥读取审计

**新增目录建议**：

```
src/datasource/
  registry.ts           # 读写数据源配置
  secrets.ts            # SecretProvider 抽象
  dialect.ts            # 方言 prompt、capabilities、schema 查询 SQL
  executors/
    sqlite.ts
    mysql.ts
    postgresql.ts
    index.ts            # createExecutor(config)
```

### 3.2 权限模型（AccessPolicy）

企业级 BI Agent 必须先做权限裁剪，再做检索和 SQL 生成。权限不只用于执行阶段，也要影响传给 LLM 的 schema，避免无权字段进入 prompt。

```typescript
interface AccessPolicy {
  subjectId: string;
  tenantId: string;
  policyVersion: string;
  roles: string[];
  allowedDataSourceIds: string[];
  allowedSchemas?: string[];
  allowedTables?: string[];
  deniedTables?: string[];
  allowedColumns?: Record<string, string[]>; // key: schema.table
  deniedColumns?: Record<string, string[]>;
  rowFilters?: TypedPolicyPredicate[];
  maskRules?: Array<{
    table: string;
    column: string;
    strategy: 'deny' | 'hash' | 'partial';
  }>;
}
```

`TypedPolicyPredicate` 必须是受限、可参数绑定的表达式模型，禁止把任意 SQL 字符串直接拼接到生成 SQL 中。优先级如下：

1. 优先使用数据库原生 RLS、授权视图或按租户隔离的 ADS 表
2. 指标路径由语义编译器生成权限谓词
3. ad-hoc 路径使用方言 AST 改写，并对改写后的 SQL 再次校验
4. 无法证明谓词已覆盖所有 CTE / UNION / 子查询 / 表别名时直接拒绝
5. 所有值通过驱动参数绑定，禁止字符串插值

**执行顺序**：

1. `datasourceRouter` 只在 `allowedDataSourceIds` 内选源
2. `SchemaRetriever` 只检索用户可见表/字段
3. `SchemaAssembler` 移除无权列、敏感列，补齐 policy 所需字段
4. `SqlValidator` 校验生成 SQL 未越权访问表/列
5. `SqlExecutor` 执行前确认数据库侧权限和 AST 改写结果；无法安全注入时拒绝
6. `ResultPolicy` 在返回前再次执行列掩码、最小聚合人数和响应体限制

### 3.3 语义层 / 指标层

**定义的是原子能力，不是每种查询组合**：

```yaml
# metadata/metrics/retail/gmv.yaml
metric: gmv
version: 1
label: GMV（成交总额）
datasourceId: sales_mysql
status: certified
owner: retail-bi
factTable: ads.ads_order_wide
entityKey: order_id
measure:
  field: pay_amount
  aggregation: sum
  additive: true
timeDimension: order_date
timezone: Asia/Shanghai
unit: CNY
defaultFilters:
  - "status IN ('paid', 'shipped')"
dimensions:
  - name: city
    joinPath: order_user
  - name: order_date
  - name: category_l1
  - name: channel
synonyms: [GMV, 成交总额, 销售额, 流水]
```

运行时组合：`gmv × city × 2025-03 × filter(北京)` → 编译 SQL，无需预先定义该具体问法。

指标定义还必须覆盖：聚合前/后过滤、去重键、时间粒度、单位/币种、空值策略、维度 join path、join cardinality、fanout 防护、数据新鲜度 SLA、生效/废弃时间和审核状态。指标表达式与过滤条件使用受限 DSL，不接受任意 SQL 字符串。

`certified` 指标命中后必须走确定性编译路径；编译失败应返回错误或澄清，不得静默降级到 LLM 自由 SQL，否则无法保证统一口径。

指标定义还必须覆盖：聚合前/后过滤、去重键、时间粒度、单位/币种、空值策略、维度 join path、join cardinality、fanout 防护、数据新鲜度 SLA、生效/废弃时间和审核状态。指标表达式与过滤条件使用受限 DSL，不接受任意 SQL 字符串。

`certified` 指标命中后必须走确定性编译路径；编译失败应返回错误或澄清，不得静默降级到 LLM 自由 SQL，否则无法保证统一口径。

**新增目录建议**：

```
metadata/
  metrics/{domain}/*.yaml
  domains/*.yaml
src/semantic/
  metric-registry.ts
  sql-compiler.ts         # 指标 + 维度 + 过滤 → SQL
```

### 3.4 向量库元数据（Qdrant）

#### 3.4.1 存什么 / 不存什么

| 内容 | 入向量库 | 说明 |
|------|---------|------|
| 表/字段/关系/术语/指标描述 | ✅ | `content` 字段做 embedding |
| datasourceId, domain, docType, table, column | ✅ | payload metadata，用于过滤 |
| schemaVersion, indexedAt, sourceUpdatedAt, reviewStatus | ✅ | 新鲜度、审核和失效判断 |
| host, port, password | ❌ | 仅 Registry |

#### 3.4.2 文档类型

| docType | 数量策略 | 用途 |
|---------|----------|------|
| datasource | 每源 1 条 | query → 选库 |
| table | 每表 1 条 | query → 选表 |
| column | 核心列单独；次要列分组 | query → 选字段 |
| column_group | 5～15 列一组 | 降低文档总量 |
| relation | 按需 | Join 提示 |
| metric | 每指标 1 条 | 口径 + 同义词 |
| qa_pair | 可选 | 历史问答提升 Text-to-SQL |

#### 3.4.3 字段分级（控制文档规模）

| 级别 | 说明 | 入库策略 |
|------|------|----------|
| L1 核心 | 指标列、主维度、时间列 | 每列 1 文档 |
| L2 常用 | 次要维度、状态 | 可 5～10 列 1 文档 |
| L3 冷门 | ETL 字段、内部 flag | 不入库，或仅列在表摘要 |

**规模估算**：

```
1,000 张 ADS 宽表 × (1 表摘要 + 20 核心字段 + 3 字段组) ≈ 24,000 文档
10,000 张宽表（全暴露，不推荐）≈ 240,000 文档
```

均在 Qdrant 舒适范围内（精选策略 10 万～30 万 document；全量逐字段可达 200 万，不推荐）。

#### 3.4.4 Qdrant 选型说明

- Qdrant **无**「百万条上限」；单 collection 理论上可达百亿级 point
- BI 元数据场景预估 10 万～50 万 document，**继续使用 Qdrant**（项目已依赖 `@langchain/qdrant`）
- 仅当总量持续增长至 5000 万+ 且需大规模分布式集群时，再评估 Milvus

**新增目录建议**：

```
metadata/                  # 可选：Markdown + YAML frontmatter 维护
  datasources/
  tables/
  columns/
  metrics/
src/metadata/
  indexer.ts               # scan → buildDocuments → upsert
  retriever.ts             # 分层检索 → assembleSchema
  types.ts                 # SchemaDocument, RetrievedSchema
```

**索引生命周期要求**：

- 每条文档携带 `schemaVersion`、`indexedAt`、`sourceUpdatedAt`、`contentHash`、`embeddingModelVersion`
- schema 删除或权限撤销时写入 tombstone，并保证旧文档不再可检索
- 全量重建写入新 collection，通过 alias 原子切换，失败时可回滚
- 元数据描述、数据库 comment 和自动生成内容均视为不可信数据，不能作为 prompt 指令
- 自动生成描述必须经过审核；生产检索默认只使用 `reviewStatus=approved`
- 权限策略改变后必须使相关缓存和会话内 schema 失效

### 3.5 SchemaAssembler（精简 schema 组装）

RAG 的目标不是把 schema 从数据库搬到向量库后再全量塞回 LLM，而是稳定找出本次查询所需的 schema 子集。

```typescript
interface RetrievedSchema {
  datasourceId: string;
  dialectFamily: DialectFamily;
  tables: Array<{
    schema?: string;
    name: string;
    columns: Array<{
      name: string;
      type: string;
      description?: string;
      reason:
        | 'matched'
        | 'join_key'
        | 'time_key'
        | 'metric_dependency'
        | 'policy'
        | 'fallback';
    }>;
    omittedColumnCount?: number;
  }>;
  joins?: Array<{ left: string; right: string; type: 'one_to_many' | 'many_to_one' | 'many_to_many' }>;
  hints: string[];
}
```

**字段裁剪规则**：

- 每张宽表默认传入 20～40 个字段，超过阈值必须给出 `omittedColumnCount`
- 命中的业务字段、join key、时间字段、metric dependency 不能漏
- `pii` / `sensitive` 字段默认不进入 prompt
- SQL 失败且错误疑似缺字段时，允许二次召回更多字段
- 字段召回应可测试：给定 query，断言必须字段被包含、禁止字段被排除

**建议字段标签**：

`metric`、`dimension`、`filter`、`join_key`、`time_key`、`policy_key`、`pii`、`sensitive`、`deprecated`、`internal`

### 3.6 Agent 工作流演进

#### 3.6.1 扩展 State

```typescript
// 允许持久化的业务状态；可信身份和完整权限不放入 AgentState
dataSourceId: string
dialectFamily: DialectFamily
domain: string
queryPath: 'metric' | 'rag'
matchedMetrics: string[]
retrievedSchema: RetrievedSchema | null
logicalQuery: LogicalQuery | null
clarification: ClarificationRequest | null
confidence: number
```

`principal`、完整 `AccessPolicy`、deadline、AbortSignal、secretRef 和连接配置由 `RequestContext` 注入。为兼容现有原型可分阶段迁移，但生产 Profile 不允许从 checkpointer 恢复或由模型修改这些可信字段。

#### 3.6.2 新节点

```
START
  → principalGuard             # 使用 RequestContext 验证主体、租户、会话所有权
  → planner                    # 解析 analysisQuery
  → accessPolicyLoader         # 加载用户权限
  → datasourceRouter           # 权限 + 会话 + 向量选源
  → queryPathRouter
      ├─ metricResolver → semanticValidator
      └─ ragRetriever → schemaAssembler
  → logicalQueryBuilder        # 结构化 measure/dimension/filter/timeRange
  → policyPlanValidator        # 在生成 SQL 前验证对象、范围和授权
  → dialectCompiler            # LogicalQuery → SQL AST → SQL
  → sqlValidator               # 语法 + 对象 + 作用域 + 成本校验
  → codeInterpreter            # 按 dataSourceId 选 executor
  → shouldRetry → retry
  → resultPolicy               # 列掩码、最小聚合人数、响应大小限制
  → chartFormatter → narrative
  → auditFinalizer
  → END
```

- `certified` metric 路径生成确定性 SQL，不再经过自由 `sqlGenerator`
- metric 编译失败返回错误或澄清，不允许静默降级到 RAG 路径
- 重试只能修复语法/未知字段等可修复错误；权限、成本、超时和连接错误不得盲目重新生成
- 重试过程中 `principal`、`policySnapshot`、`dataSourceId` 不可由 LLM 修改
- 长尾问题允许受控自由 SQL fallback，但必须经过相同的 AST、对象、作用域、成本和结果策略

#### 3.6.3 前端只传 query 时的选源逻辑

```
1. getUserDataSources(principal)        → 权限过滤
2. session.lastDataSourceId + 追问检测  → 会话延续
3. sources.length === 1                 → 默认源
4. 否则 vectorSearch(query, docType=datasource, filter=sources)
5. 低置信度 → 澄清追问，不执行 SQL
```

### 3.7 统一 SQL 执行引擎

替换当前 `createExecuteCodeTool(db)` 的 SQLite 硬绑定：

```typescript
interface SqlExecutor {
  execute(request: SqlExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
  explain?(sql: string): Promise<string>;
  cancel?(queryId: string): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
  listTables/schemas?: ...;
  listColumns?(table: string): Promise<ColumnMeta[]>;
}
```

**必须实现的安全约束**：

- 仅允许无副作用查询（方言 AST 校验）；显式禁止 `SELECT INTO`、文件导出、过程调用、数据库链接和危险函数
- 数据库账号必须物理只读，并限制可访问 schema / table / function；AST 校验不是唯一安全边界
- 超时必须在数据库驱动/服务端真正生效，支持 statement cancellation，不能只在应用层 `Promise.race`
- 最大返回行数（如 `LIMIT 10000`，无 LIMIT 时自动包裹或拒绝）
- 查询成本控制：`EXPLAIN` / 分区条件 / 禁止超大明细表无过滤扫描
- 审计日志：requestId, subjectId, tenantId, sessionId, datasourceId, query, sql, duration, rowCount
- 行级/列级权限（Phase A 定义可信接口，Phase B 单源闭环即强制执行，Phase D 扩展到多源）
- 运行时只读：禁止 CREATE / INSERT / UPDATE / DELETE / DROP / ALTER / TRUNCATE
- 函数 allowlist/denylist、递归 CTE 深度、JOIN 数量、响应体字节数和并发配额均可配置
- 每数据源连接池、健康检查、熔断和每租户并发隔离

**安全错误模型**：数据库原始错误只写入受控审计，不直接返回用户或发送给 LLM。

```typescript
type SqlFailureKind =
  | 'syntax_error'
  | 'unknown_table'
  | 'unknown_column'
  | 'permission_denied'
  | 'timeout'
  | 'cost_rejected'
  | 'policy_rejected'
  | 'connection_error'
  | 'unknown';
```

只有 `syntax_error`、`unknown_table`、`unknown_column` 可进入受限自愈；传给 LLM 的是脱敏后的 `kind + safeMessage`。

**结果防泄漏（ResultPolicy）**：

- 返回前再次执行列级掩码和禁止列检查
- 可配置最小聚合人数，例如分组人数小于 5 时拒绝或合并
- Narrative / 图表推荐默认只接收聚合摘要、列类型和脱敏样本，不接收完整明细
- 限制返回行数、字段数、响应体大小；明细下载使用独立权限
- 防止通过图表标签、SQL debug 信息和多次差分查询推断个人数据

`src/db/seed.ts` 中的 `createDatabase` / `seedDatabase` 仅保留为 demo/test fixture，不进入企业级运行时链路。

### 3.8 generate_sql 改造

```typescript
logicalQueryBuilder.invoke({
  query: analysisQuery,
  schema: retrievedSchema,      // 非 getSchema 全量
  hints: matchedMetricHints,    // 如 GMV 口径
});

dialectCompiler.compile({
  logicalQuery,
  dialect: dialectFamily,
  capabilities: dbCapabilities,
});
```

### 3.9 逻辑查询中间层（LogicalQuery）

```typescript
interface LogicalQuery {
  source: string;
  measures: Array<{ ref: string; aggregation?: string }>;
  dimensions: Array<{ ref: string }>;
  filters: FilterExpression[];
  timeRange?: { field: string; from: string; to: string; timezone: string };
  orderBy?: Array<{ ref: string; direction: 'asc' | 'desc' }>;
  limit?: number;
}
```

- `LogicalQuery` 使用 Zod/JSON Schema 校验，LLM 只能引用检索后授权的逻辑对象 ID
- 权限、fanout、时间范围、最大明细粒度和成本预算先在逻辑层校验，再进入方言编译
- metric 与 RAG 路径复用同一执行链；metric 负责生成确定性 LogicalQuery，RAG 负责受控绑定字段
- SQL AST 和最终 SQL 都作为派生产物，不作为多轮会话中的权威业务状态

### 3.10 结构化澄清协议

```typescript
interface ClarificationRequest {
  reason:
    | 'ambiguous_metric'
    | 'ambiguous_datasource'
    | 'missing_time_range'
    | 'unauthorized_scope'
    | 'cross_source_query';
  question: string;
  options?: Array<{ id: string; label: string }>;
}
```

低置信度、多个同名指标、多个候选数据源、缺少必要时间范围或跨源问题必须先澄清，不得猜测后执行 SQL。澄清选项使用服务端 ID，前端展示 label，后续请求仍需重新进行权限校验。

### 3.11 数据质量与新鲜度

每个数据源、表和 certified metric 维护 `dataAsOf`、时区、更新频率、freshness SLA、质量检查状态和不完整分区信息。结果响应统一包含：

```typescript
interface DataFreshness {
  dataAsOf: string;
  timezone: string;
  status: 'fresh' | 'stale' | 'unknown';
  warnings: string[];
}
```

- “今天/本周/本月”必须基于明确业务时区和日历，不能依赖应用服务器本地时区
- 数据超过 SLA、分区未完成或质量检查失败时，回答必须显式降置信度或拒绝关键指标结论
- 财务周期、自然周、业务日、币种和单位规则由语义层定义并版本化

### 3.12 权限感知缓存

缓存按 metadata、路由、LogicalQuery 编译、SQL 结果和 narrative 分层。缓存 key 至少包含：

`tenantId + policyScopeHash + dataSourceId + metadataVersion + metricVersion + logicalQueryHash`

- 权限/角色变化、metadata alias 切换、metric 新版本和数据刷新事件必须触发失效
- 包含敏感明细的结果默认不缓存；跨用户共享仅允许经过认证的聚合结果
- 缓存命中仍执行 ResultPolicy，不得把缓存视为权限证明

### 3.13 模型与 Prompt 治理

- Prompt、tool schema、模型 provider/model/version 和 embedding model 全部版本化并进入审计
- 模型升级必须通过 golden dataset、攻击集、路由/SQL/结果一致性和成本回归门禁
- 元数据 comment、用户输入和数据库内容均视为不可信数据，与系统指令分区传递
- LLM 输出必须通过结构化 Schema 校验；连接串、secretRef、内部策略和原始数据库错误永不进入模型上下文
- 对每个请求设置 token、LLM 调用次数和自愈次数预算；fallback 不得改变数据驻留或合规边界

### 3.14 导出与高风险操作

- 在线分析接口只返回受限行数和聚合结果；大结果导出走独立异步 job
- 导出定义独立权限、审批、租户配额、文件加密、TTL、一次性下载、水印和完整审计
- CSV/Excel 导出执行公式注入防护；包含 PII 的导出默认拒绝或要求增强审批
- 跨数据源 join、写回、调度和报表分发不属于当前在线查询链路，后续单独立项

---

## 4. 元数据文档规范

### 4.1 存储格式

- **向量库**：JSON point（`vector` + `payload`）
- **维护载体**：推荐 Markdown + YAML frontmatter，脚本同步到 Qdrant
- **`content`**：Markdown 风格自然语言，用于 embedding
- **给 LLM**：检索后程序化组装精简 JSON schema，非全文 Markdown

### 4.2 字段级文档示例

```markdown
---
docType: column
datasourceId: sales_mysql
domain: retail
dialectFamily: mysql
schema: ads
table: ads_order_wide
column: pay_amount
dataType: DECIMAL(18,2)
tags: [GMV, 金额, 核心指标]
sensitivity: normal
fieldRole: metric
---

# 字段：ads.ads_order_wide.pay_amount

## 业务含义
用户实际支付金额，GMV 核心口径。统计 GMV 时使用 SUM(pay_amount)。

## 常用口径
GMV：SUM(pay_amount) WHERE status IN ('paid', 'shipped')

## 同义词
支付金额、实付、GMV、成交额

## 常一起使用
order_date（时间）、city（地域）、status（过滤）
```

### 4.3 检索后给 LLM 的 schema 示例

```json
{
  "datasourceId": "sales_mysql",
  "dialectFamily": "mysql",
  "tables": [{
    "schema": "ads",
    "name": "ads_order_wide",
    "columns": [
      { "name": "pay_amount", "type": "DECIMAL(18,2)", "description": "GMV口径" },
      { "name": "city", "type": "VARCHAR(64)", "description": "用户城市" },
      { "name": "order_date", "type": "DATE", "description": "下单日期" }
    ],
    "omittedColumnCount": 82
  }],
  "columnReasons": {
    "ads_order_wide.pay_amount": "matched",
    "ads_order_wide.city": "matched",
    "ads_order_wide.order_date": "time_key"
  },
  "hints": ["GMV: SUM(pay_amount) WHERE status IN ('paid','shipped')"]
}
```

---

## 5. 分阶段实施计划

所有阶段按 TDD 执行；行为变更必须先有失败测试和测试 ID。阶段完成的定义不是“代码已提交”，而是相应能力从 `prototype` 升级为 `verified` 或 `production-certified`。

### Phase A：基线与可信边界（3～4 周）

**目标**：建立可发布、可测试、fail-closed 的单源运行时，不再依赖隐式 demo fallback。

| 任务 | 产出 |
|------|------|
| 补齐 typecheck/unit/contract/integration-local/e2e-local/build/artifact verify | `package.json`, CI |
| 定义 `APP_ENV`、Zod 配置、`RuntimeProfile` 和 Composition Root | `src/config/`, `src/bootstrap/` |
| 最小 HTTP API + 认证中间件 + `RequestContext` | `src/api/`, `src/auth/` |
| 从生产 Graph State 移除 principal/完整 policy 信任，恢复会话后重新鉴权 | `src/state.ts`, `src/agent.ts` |
| 删除生产路径 test principal/default tenant/default datasource/demo retriever fallback | production profile |
| 固化 `SqlExecutor`、`SecretProvider`、Registry contract | `src/datasource/` |
| 统一审计事件、错误分类和 traceId | `src/audit/`, `src/errors/` |
| SQLite 完成只读、超时取消、ResultPolicy 和攻击集闭环 | executor/validator/tests |

**验收**：

- development/test 使用完整 API/Agent 节点，差异仅限适配器和数据生命周期
- staging/production 只运行 `dist/` artifact；缺 principal、policy、密钥或依赖时启动/请求失败，不回退本地实现
- 跨租户/session、伪造身份、危险 SQL、越权对象和原始错误泄漏测试全部通过
- statement cancellation 可证明在数据库侧生效；生产 artifact 不含 demo DB、`.env`、fixture 和测试 Principal
- 所有 adapter 通过同一 contract suite，当前单元/集成基线无回退

### Phase B：单数据源企业闭环 + Schema RAG（4～6 周）

**目标**：先选择一个真实目标数据库，把认证、权限、Qdrant、执行、审计和回滚形成生产候选闭环。

| 任务 | 产出 |
|------|------|
| Qdrant retriever/indexer、metadata version、freshness、tombstone、alias 回滚 | `src/metadata/` |
| 权限前置到数据源、表、列检索和 SchemaAssembler | retriever/policy |
| 完整方言 AST：语法、对象、函数、作用域和成本校验 | `src/datasource/sql-validator.ts` |
| 真实策略服务/配置源、policyVersion 和缓存失效 | `src/policy/` |
| 持久化 checkpointer、会话 TTL、权限变更失效 | `src/session/` |
| 数据质量、新鲜度、业务时区和结果告警 | metadata/result contract |
| Schema RAG golden dataset、攻击集和召回离线评测 | `tests/evaluation/` |

**验收**：

- “北京用户订单总额”等 golden query 命中必需字段，禁止字段进入 prompt 的比例为 0
- metadata 更新/删除在 SLA 内生效；索引构建失败可原子回滚到旧 alias
- 真实数据库只读账号、只读事务、AST、成本预算和 statement cancellation 全部通过安全测试
- API → 认证 → 权限 → 检索 → SQL → 执行 → ResultPolicy → 审计端到端通过
- 回答包含 `dataAsOf`、timezone、freshness status 和 warnings

### Phase C：逻辑查询与核心指标层（4～6 周）

**目标**：核心 KPI 走确定性语义路径，长尾 RAG 也优先生成受控 `LogicalQuery`。

| 任务 | 产出 |
|------|------|
| `LogicalQuery` Schema、builder、policy validator 和 dialect compiler | `src/query-plan/` |
| 指标 YAML + `MetricRegistry` + certification workflow | `metadata/metrics/`, `src/semantic/` |
| join graph、cardinality、fanout、时间/币种/单位规则 | `src/semantic/` |
| 结构化澄清协议和低置信度路由 | `src/agent.ts`, API contract |
| 5～10 个核心 certified metrics 及 golden datasets | metadata/tests |

**验收**：

- certified metric 口径正确率 100%，编译失败不静默降级为自由 SQL
- 一对多/多对多 fanout、默认过滤、财务周期、时区、币种和单位测试全部通过
- RAG 路径只能引用授权逻辑对象；LogicalQuery 与 SQL AST 均可审计和快照测试
- 指标歧义、数据源歧义和缺少时间范围时返回结构化澄清，不猜测执行

### Phase D：多数据源与方言认证（5～8 周）

**目标**：在单源闭环稳定后扩展 PostgreSQL/MySQL，并建立逐产品认证机制。

| 任务 | 产出 |
|------|------|
| `DataSourceRegistry` + SecretProvider + capability override | `src/datasource/` |
| PostgreSQL/MySQL executor、连接池、TLS、健康检查、熔断 | executors |
| 方言 compiler/introspection 和 conformance contract tests | dialect/tests |
| datasourceRouter：权限、会话、置信度、冲突澄清 | `src/agent.ts` |
| 每产品支持状态和 production certification 报告 | registry/docs |

**验收**：

- 不同 query 可正确路由到不同授权源，多源路由 Top-1 达到评测门槛
- MySQL/PostgreSQL 的安全语句、日期函数、分页、超时取消和能力声明通过 conformance tests
- 单个慢源不会耗尽全局连接池或阻塞其他租户
- 跨源 join 明确拒绝或澄清；不会由 LLM 自行拼接多个连接
- 只有 `production-certified` 产品可用于生产关键查询

### Phase E：产品化与治理（6～10 周）

**目标**：具备企业前端接入、运营、审计、容量和发布治理能力。

| 任务 | 产出 |
|------|------|
| SSE/流式状态、查询历史、可信 narrative | API/frontend contract |
| 审计持久化、查询、保留策略和字段分级 | `src/audit/` |
| 权限感知缓存、慢查询、EXPLAIN、采样和分页 | cache/executors |
| 限流、租户并发、请求取消、SLO/告警、灰度和回滚 | runtime/ops |
| 异步导出 job、审批、加密、TTL、水印和 CSV 注入防护 | export service |
| Prompt/模型版本治理、真实模型 evaluation 和成本预算 | model governance |

**验收**：

- 普通用户只看到逻辑元信息；物理 SQL/表字段仅对具备 `BI_QUERY_DEBUG` 权限的管理员开放
- 会话、缓存、导出和审计全部具备租户隔离、权限失效和多实例一致性
- 达到上线前确定的可用性、P95/P99、并发、取消率、错误率和单请求成本 SLO
- 使用同一 production artifact 完成 staging E2E、故障演练、metadata alias 回滚和应用版本回滚

### Phase F：规模化元数据（持续）

**目标**：支撑上千张 ADS/DWS 表，同时维持可控文档量、审核质量和检索延迟。

| 任务 | 产出 |
|------|------|
| 自动 schema 扫描、分片增量同步和变更检测 | `src/metadata/scanner.ts` |
| 字段 L1/L2/L3 分级、owner 和人工审核流 | `src/metadata/grading.ts` |
| LLM 辅助描述但禁止自动 certification | 管理脚本/API |
| 冷门列动态 introspection 兜底 | retriever |
| 更多数据库产品映射和 executor 认证 | `src/datasource/` |

**规模目标**：1,000 张 ADS 表约 24,000 文档；检索 Step 1～3 的 P99 目标小于 100ms，最终门槛以实际容量测试为准。

## 6. 目录结构（目标态）

```
apps/bi-analyst/
├── docs/
│   └── ENTERPRISE-PLAN.md          # 本文档
├── metadata/                        # 元数据维护（Markdown/YAML）
│   ├── datasources/
│   ├── tables/
│   ├── columns/
│   └── metrics/
├── src/
│   ├── agent.ts                     # LangGraph 工作流
│   ├── state.ts
│   ├── entities.ts
│   ├── config/
│   │   ├── env.ts                   # APP_ENV + Zod 配置校验
│   │   └── types.ts
│   ├── bootstrap/
│   │   ├── index.ts                 # Composition Root，唯一环境分流入口
│   │   ├── local-profile.ts
│   │   └── production-profile.ts
│   ├── auth/
│   │   └── principal.ts             # 可信主体 + 会话所有权校验
│   ├── runtime/
│   │   └── request-context.ts       # requestId/traceId/principal/deadline/policy
│   ├── api/                         # Phase A 最小 API；Phase E 产品化增强
│   │   └── server.ts
│   ├── audit/                       # Phase A 事件接口；Phase E 持久化与查询
│   ├── errors/                      # 安全错误分类与脱敏
│   ├── session/                     # 持久化 checkpointer、TTL、权限失效
│   ├── policy/
│   │   └── result-policy.ts         # 返回前防泄漏策略
│   ├── query-plan/
│   │   ├── logical-query.ts
│   │   ├── policy-validator.ts
│   │   └── dialect-compiler.ts
│   ├── datasource/
│   │   ├── registry.ts
│   │   ├── secrets.ts
│   │   ├── capabilities.ts
│   │   ├── dialect.ts
│   │   ├── sql-validator.ts
│   │   ├── types.ts
│   │   └── executors/
│   ├── metadata/
│   │   ├── indexer.ts
│   │   ├── retriever.ts
│   │   ├── retriever-qdrant.ts
│   │   ├── schema-assembler.ts
│   │   ├── scanner.ts
│   │   └── grading.ts
│   ├── semantic/
│   │   ├── metric-registry.ts
│   │   └── sql-compiler.ts
│   ├── cache/                        # 权限感知的分层缓存
│   ├── export/                       # 异步导出与高风险操作
│   └── tools/
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   │   ├── local/
│   │   └── services/
│   ├── e2e/
│   ├── security/
│   ├── evaluation/
│   └── fixtures/
├── scripts/
│   └── verify-production-artifact.ts
├── tsconfig.build.json
└── config/
    └── datasources.example.yaml     # 数据源配置示例（无真实密码）
```

---

## 7. 接口约定

### 7.1 前端 → API

```json
POST /api/analyze
{
  "query": "查一下北京用户上个月的订单总额",
  "sessionId": "sess-abc"
}
```

`userId`、`tenantId`、roles 由认证中间件从可信凭据构造 `AuthenticatedPrincipal`，请求体中的同名字段即使存在也必须忽略或拒绝。

### 7.2 API → 前端

```json
{
  "finalAnswer": "北京用户上个月订单总额为 ...",
  "chartSpec": { "type": "bar", "title": "...", "option": {} },
  "meta": {
    "queryPath": "rag",
    "confidence": 0.92,
    "metric": null,
    "dataFreshness": {
      "dataAsOf": "2026-07-09T10:00:00Z",
      "timezone": "Asia/Shanghai",
      "status": "fresh",
      "warnings": []
    },
    "requestId": "req-abc",
    "traceId": "trace-abc"
  }
}
```

物理 `dataSourceId`、生成 SQL、表名、字段名和完整指标实现属于调试信息，仅在当前主体拥有 `BI_QUERY_DEBUG` 权限时返回，并对 SQL literal、租户条件和敏感字段脱敏：

```json
{
  "debugMeta": {
    "dataSourceId": "ecommerce_sqlite",
    "generatedSql": "SELECT ...",
    "tables": ["users", "orders"],
    "columns": ["users.city", "orders.amount", "orders.user_id"]
  }
}
```

低置信度时：

```json
{
  "finalAnswer": "您指的是销售订单总额还是财务收入总额？",
  "needsClarification": true,
  "clarification": {
    "reason": "ambiguous_metric",
    "question": "请选择需要分析的指标口径",
    "options": [
      { "id": "metric.sales.gmv", "label": "销售订单总额" },
      { "id": "metric.finance.revenue", "label": "财务收入总额" }
    ]
  }
}
```

---

## 8. 企业级评测体系

企业级 BI Agent 必须有可持续评测，而不是只靠 demo 问答观察效果。

| 评测项 | 指标 |
|------|------|
| 多源路由准确率 | query → datasourceId 是否正确 |
| 表召回率 | 必要表是否被检索命中 |
| 字段召回率 | 必要字段、join key、time key、policy key 是否进入 `RetrievedSchema` |
| 字段精简率 | 宽表最终传给 LLM 的字段数是否受控 |
| 敏感字段拦截 | `pii` / `sensitive` 字段是否被排除 |
| Text-to-SQL 正确率 | SQL 是否可执行，结果是否符合 golden answer |
| 指标命中率 | 核心 KPI 是否走 metric 路径，口径是否正确 |
| 安全拦截 | DDL/DML、多语句、越权表列、无过滤大表扫描是否被拒绝 |
| 延迟与成本 | RAG、LLM、SQL 执行耗时；token 成本；Qdrant 查询耗时 |
| 自愈合质量 | SQL 失败后是否能修复，是否会越权扩展 schema |
| 身份与会话隔离 | 伪造 user/tenant、跨用户 session、权限变更后的旧会话是否被拒绝 |
| 结果防泄漏 | 掩码、最小聚合人数、明细权限、debug 信息是否正确执行 |
| 元数据新鲜度 | 删除、改名、权限撤销和未审核文档是否及时失效 |
| 方言一致性 | 每个 verified 产品是否通过 capability / validator / executor 合约测试 |
| 环境装配正确性 | local/profile 是否按 APP_ENV 装配；非法环境是否 fail closed；生产是否禁止本地 fallback |
| 本地全流程一致性 | development/test 是否执行相同节点集合，并通过同一组端到端业务场景 |
| 构建产物纯净度 | `dist/` 是否排除 fixture、demo DB、测试身份、`.env` 和测试专用代码 |
| TDD 可追溯性 | 验收项是否有测试 ID；bug 是否先有失败回归测试；关键分支覆盖是否达标 |

**最低质量门槛（进入生产前）**：

| 指标 | 门槛 |
|------|------|
| 权限绕过、跨租户访问成功数 | 0 |
| DDL/DML/多语句/副作用 SELECT 拦截率 | 100% |
| 敏感字段进入 prompt 或普通响应的泄漏率 | 0 |
| 超时后数据库 statement 实际取消率 | 100% |
| certified metric 口径正确率 | 100% |
| 多源路由 Top-1 准确率 | ≥ 95% |
| 必需表召回率 | ≥ 98% |
| 必需字段召回率 | ≥ 97% |
| SQL execution accuracy | ≥ 90% |
| 固定数据快照 golden result accuracy | ≥ 85% |
| 审计事件完整率 | 100% |
| 环境错误配置 fail-closed | 100% |
| development/test 本地 E2E 必选场景通过率 | 100% |
| 生产适配器降级到本地实现次数 | 0 |
| 生产产物包含测试/密钥/demo 资产数 | 0 |
| 关键安全、策略拒绝、指标编译分支覆盖率 | 100% |
| P95/P99、单请求 token 和查询成本 | 上线前按环境容量测试确定预算并纳入门禁 |

**测试资产**：

- `tests/fixtures/golden-queries/*.json`：自然语言问题、期望数据源、期望表字段、期望 SQL 特征、期望结果摘要
- `tests/fixtures/access-policies/*.json`：不同角色/租户的权限样本
- `tests/fixtures/metadata/*.md`：小型 metadata 样本，支持无 Qdrant 的快速测试
- `tests/fixtures/security/*.json`：CTE / UNION / 子查询 / SELECT INTO / 危险函数 / prompt injection 攻击样本
- `tests/fixtures/dialect/*.json`：各产品 capability 和 SQL 方言合约样本
- `tests/fixtures/metrics/*.json`：时间、时区、币种、去重和 fanout 指标样本
- `tests/contract/*.test.ts`：本地/生产 adapter 共用的接口行为测试
- `tests/integration/local/*.test.ts`：使用 test 本地全栈 Profile 覆盖完整 Agent 内部链路
- `tests/e2e/local/*.test.ts`：从 HTTP API 到响应、审计和会话状态的本地全流程测试
- `tests/e2e/*.test.ts`：对生产 `dist/` 产物执行 staging 验证
- 失败样本沉淀：线上执行失败、用户纠错、低置信度追问都应回流评测集

### 8.1 CI/CD 测试与发布门禁

建议流水线固定为以下顺序，任一步失败均不得发布：

```text
install --frozen-lockfile
  → typecheck
  → unit
  → contract
  → integration-local
  → e2e-local
  → security/evaluation
  → build production artifact
  → verify artifact
  → integration-services
  → deploy staging
  → E2E staging + smoke + SLO check
  → approval
  → promote 同一 artifact 到 production
```

- staging 和 production 必须使用同一个构建产物，禁止在生产环境重新编译
- 发布产物附带 commit SHA、dependency lock hash、config schema version、metadata version 和评测报告
- 回滚使用上一份已验证 artifact 与兼容的 metadata alias，不临时修改生产代码
- 测试失败不得通过“仅在 CI 跳过”绕过；如需隔离 flaky case，必须有负责人、期限和阻断级跟踪项

---

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 宽表全量逐字段入库，文档爆炸 | 字段分级 + 分组 + 仅 ADS 层 |
| 宽表全字段进入 LLM，token 爆炸且干扰生成 | `SchemaAssembler` 字段精简，默认 20～40 字段 |
| 敏感字段进入 prompt | 字段标签 + 权限裁剪 + prompt 前最终检查 |
| 请求体伪造 userId / tenantId 或劫持 session | 可信认证主体 + 会话所有权校验 + tenant/user/session 复合键 |
| Text-to-SQL 方言错误 | dialect prompt + capabilities + 执行失败重试 |
| 多源选错 | 权限过滤 + 置信度阈值 + 澄清追问 |
| 将多源路由误解为跨源 join | 文档和 API 明确单查询单源；跨源分析另立阶段 |
| 口径不一致 | 核心 KPI 强制走 metric 路径 |
| 连接信息泄露 | 密码不进向量库、不进 LLM prompt |
| 密码落入 YAML/环境变量后长期遗留 | SecretProvider + 生产密钥系统 + 轮换与读取审计 |
| LLM 生成高成本 SQL 拖垮业务库 | SQL Validator + EXPLAIN + 超时 + 行数限制 + 大表扫描拦截 |
| SELECT 语句产生副作用或调用危险函数 | 数据库只读账号 + AST allowlist + 函数限制 + 只读事务 |
| 权限只在执行阶段生效，schema 已泄露 | 权限前置到检索和 schema 组装阶段 |
| 行级过滤字符串拼接被绕过 | 数据库原生 RLS/授权视图优先；typed predicate + AST 改写后再校验 |
| 原始数据库错误泄露给用户或 LLM | 错误分类、脱敏 safeMessage、按错误类型控制重试 |
| 执行结果或图表/narrative 二次泄漏 | ResultPolicy + 最小聚合人数 + 掩码 + 仅传脱敏摘要 |
| 元数据过期、删除字段仍被召回 | schemaVersion + tombstone + alias 原子切换 + freshness 检查 |
| 元数据 comment 形成间接 prompt injection | 元数据视为不可信数据 + 审核状态 + prompt 数据/指令隔离 |
| 环境变量缺失后误启用本地实现 | APP_ENV 枚举校验 + Composition Root 唯一分流 + 非法环境 fail closed |
| 生产依赖异常时回退 SQLite/mock | 生产 Profile 禁止 fallback，初始化失败直接终止并告警 |
| 本地适配器与生产适配器行为漂移 | 共用接口 + contract tests + staging 对生产 artifact 做 E2E |
| 测试通过但发布产物夹带 fixture/密钥 | 独立 production build + artifact verify + 同一产物晋级发布 |
| 先实现后补测试导致安全边界不可证明 | TDD Red-Green-Refactor + 验收测试 ID + PR 门禁 |
| deterministic adapter 被误解为跳过全链路 | test 仍运行完整 API/Agent 节点；adapter 只控制模型输出的可重复性 |
| 本地全流程通过但真实模型效果回退 | 独立真实模型 evaluation job + golden dataset + 模型版本门禁 |
| 过度 mock 导致集成问题遗漏 | local E2E + integration-services + staging E2E；mock 仅用于 unit 边界隔离 |
| Qdrant 规模误解 | 10 万～50 万 document 足够；优先优化检索策略而非换库 |
| 国产库兼容模式 | productType + mode 字段，复用 mysql/oracle 方言族 |

---

## 10. 里程碑总览

| 阶段 | 周期 | 交付物 | 优先级 |
|------|------|--------|--------|
| Phase A 基线与可信边界 | 3～4 周 | RuntimeProfile + 最小 API + RequestContext + CI/安全门禁 | P0 |
| Phase B 单源企业闭环 + Schema RAG | 4～6 周 | 真实单源 + Qdrant + AST/权限/审计/回滚闭环 | P0 |
| Phase C 逻辑查询与核心指标层 | 4～6 周 | LogicalQuery + 指标编译 + fanout + 结构化澄清 | P0 |
| Phase D 多数据源与方言认证 | 5～8 周 | Registry + PostgreSQL/MySQL + 路由和产品认证 | P1 |
| Phase E 产品化与治理 | 6～10 周 | 缓存 + 导出 + SLO + 模型治理 + 发布运维 | P1 |
| Phase F 规模化元数据 | 持续 | 扫描 + 分级 + 审核 + 增量同步 | P2 |

---

## 11. 下一步行动（建议立即开始）

1. **先建测试门禁**：补齐 `typecheck`、`test:unit`、`test:contract`、`test:integration:local`、`test:e2e:local`、`build`、`verify:artifact`，并接入 CI
2. 定义 `APP_ENV`、Zod 配置 Schema、`RuntimeProfile` 和 Composition Root；为四种环境先写装配测试
3. 增加最小 HTTP API 和 `RequestContext`，将 principal/完整 policy/deadline 从可持久化 Graph State 迁出
4. 实现 `development/test` 本地全栈 Profile；实现 `staging/production` fail-closed Profile，禁止任何 demo/default fallback
5. 为现有 `AuthenticatedPrincipal`、session ownership、`AccessPolicy` 和 audit 增加端到端传递测试，消除 `subjectId=unknown` 等占位行为
6. 创建 `SecretProvider`、`DataSourceConfig`、`SqlExecutor` 和 `SchemaRetriever` contract tests，固化 SQLite/InMemory 原型边界
7. 先写 SQL 攻击集，再实现方言 AST、对象/函数/作用域/成本校验、数据库侧 cancellation 和只读事务
8. 选择第一个真实目标数据库，按 Phase B 完成 Qdrant、权限、执行、freshness、审计和回滚闭环后，再启动指标层和多数据源

---

## 附录 A：demo 元数据清单（Phase B）

| ID | docType | 说明 |
|----|---------|------|
| datasource:ecommerce_sqlite | datasource | 电商 demo 数据源 |
| ecommerce_sqlite.users | table | 用户表 |
| ecommerce_sqlite.orders | table | 订单表 |
| ecommerce_sqlite.users.id | column | 用户 ID |
| ecommerce_sqlite.users.name | column | 用户姓名 |
| ecommerce_sqlite.users.city | column | 城市 |
| ecommerce_sqlite.users.created_at | column | 注册时间 |
| ecommerce_sqlite.orders.user_id | column | 外键 |
| ecommerce_sqlite.orders.amount | column | 订单金额 |
| ecommerce_sqlite.orders.status | column | 订单状态 |
| ecommerce_sqlite.orders.created_at | column | 下单时间 |
| ecommerce_sqlite.orders→users | relation | Join 关系 |
| metric:order_total_amount | metric | 订单总额指标 |

---

## 附录 B：数据库产品映射清单

前端/管理后台配置用 `productType`，运行时映射为 `dialectFamily`：

```
Mysql, SQLServer, PostGreSQL, Oracle, DM, DRDS, PolarDB,
HybridDB_MySQL, AnalyticDB_PostgreSQL, SAP_HANA, MariaDB,
DB2, PolarDB_O, ApsaraDB_OceanBase
```

Agent 运行时**不依赖前端传入**上述类型，从 Registry 读取。

该清单表示计划支持的产品映射范围，不代表全部产品已经通过生产认证。每个产品必须在 Registry 中声明 `supportStatus: planned | experimental | verified | production-certified`，只有 `production-certified` 可用于生产关键查询。
