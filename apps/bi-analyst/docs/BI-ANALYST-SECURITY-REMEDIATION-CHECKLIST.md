# BI Analyst 企业级安全与优化整改清单

> 审计日期：2026-08-18  
> 审计范围：`apps/bi-analyst` API、认证、策略、SQL 执行、元数据、导出、部署与依赖  
> 状态约定：`[ ]` 待处理，`[~]` 处理中，`[x]` 已完成

## 结论摘要

- 上线前必须优先处理行级权限绕过、未知租户默认放行、JWT 信任边界和远程策略异步调用。
- 生产环境还需要补齐持久化 Session、导出任务、模型注册、审计与历史数据保留策略。
- 当前类型检查和已有安全/单元测试通过，但没有覆盖所有真实数据库、OIDC、Redis 和多实例场景。

## P0：上线阻断项

### [x] P0-01 行级权限可被嵌套子查询绕过

- 定位：`src/policy/row-filter-rewrite.ts:28-93`、`src/policy/prepare-sql.ts:54-83`
- 现象：只拒绝 `CTE/UNION`，通过正则改写第一个 `WHERE`；嵌套 `SELECT` 的外层表可能完全不受行过滤约束。
- 复现：对 `users` 添加行过滤时，过滤条件可能被插入 `orders` 子查询，外层 `users` 行仍全部返回。
- 修复动作：
  - 使用 SQL AST 按每个 `SELECT` 作用域注入谓词。
  - 在 AST 改写完成前，检测到任意嵌套子查询就拒绝带 `rowFilters` 的 SQL。
  - 禁止通过注释、字符串字面量或别名绕过表检测。
- 验收标准：补充嵌套子查询、相关子查询、函数子查询、别名、注释和字符串中的表名测试；任何未能证明安全改写的语句必须拒绝。

### [x] P0-02 未知租户默认放行

- 定位：`src/policy/policy-provider.ts:25-47`、`config/policies.example.json:2-9`、`config/policies.staging-acc.json:2-5`
- 现象：用户/租户没有显式策略时，回退到 `defaultAllowedDataSourceIds`；示例配置包含多个真实数据源。
- 修复动作：
  - 生产策略改为 deny-by-default，未知租户直接返回授权失败。
  - 将租户 onboarding 与策略发布绑定，未完成 onboarding 的租户不能查询。
  - 示例和 staging 配置不得被生产启动路径加载。
- 验收标准：随机 `tenantId/subjectId` 得到 403；只有显式租户策略和授权数据源才能通过策略快照测试。

## P1：高优先级安全与可用性

### [x] P1-01 JWT issuer、audience 和算法校验不强制

- 定位：`src/auth/jwt-auth-provider.ts:71-100,161-182`、`src/bootstrap/production-profile.ts:176-210`
- 风险：只要 token 使用同一 JWKS 签名，来自其他 issuer/audience 的 token 可能被接受；远程 JWKS 无超时且永久缓存，密钥轮换不及时。
- 修复动作：生产强制 `AUTH_ISSUER`、`AUTH_AUDIENCE`；显式允许 `RS256/ES256` 等算法；JWKS 增加超时、TTL、刷新和轮换失败告警。
- 验收标准：错误 issuer、audience、算法和过期 token 全部返回 401；JWKS 不可达时请求在固定时间内失败。

### [x] P1-02 远程 Policy Service 会导致分析请求全部失败

- 定位：`src/api/server.ts:588`、`src/policy/load-policy.ts:5-31`
- 现象：请求路径调用同步策略加载器，异步 provider 被识别后直接抛错。
- 修复动作：统一使用 `loadPolicyForPrincipalAsync`，并让策略加载、数据源授权和 session 校验保持异步链路。
- 验收标准：配置 `POLICY_SERVICE_URL` 后，分析、流式分析和管理接口均可正常完成；增加 provider 延迟、超时和错误测试。

### [x] P1-03 请求体无限制读取导致内存 DoS

- 定位：`src/api/server.ts:124-143,1515-1517`
- 现象：body 在认证、限流前完整读入内存，没有大小上限和读取超时。
- 修复动作：增加 `Content-Length` 预检查、流式字节计数、最大 body 配置、超时和连接中止；对所有 POST 路由统一生效。
- 验收标准：超过上限立即返回 413；慢速上传在超时后释放 socket；未认证大 body 不会持续占用内存。

### [x] P1-04 导出审批可由客户端关闭

- 定位：`src/api/server.ts:1325-1360,1378-1458`
- 现象：服务端直接信任 `body.requireApproval`；调用方可传 `false` 绕过治理要求。
- 修复动作：审批要求由服务端根据租户、数据敏感级别和策略计算；审批接口禁止申请人自审批；导出下载再次校验审批状态。
- 验收标准：客户端无论传入什么值都不能降低服务端计算出的审批级别；未审批任务无法下载。

### [x] P1-05 管理角色边界混用

- 定位：`src/api/server.ts:170-182,919-1304`
- 现象：`BI_QUERY_DEBUG`、`BI_METADATA_ADMIN`、`BI_MODEL_ADMIN` 共用 `hasOpsRole`；debug 角色可执行模型和元数据变更，且可审批导出。
- 修复动作：为模型、元数据、导出、审计分别建立最小权限检查；debug 只保留诊断能力；所有变更接口加入审计和二次确认。
- 验收标准：建立角色矩阵测试，逐路由验证允许/拒绝结果；普通 debug 用户不能 promote、rollback、review 或 approve。

### [x] P1-06 OIDC 首次会话可能立即变成 policy_stale

- 定位：`src/auth/oidc-auth-provider.ts:68-83`、`src/api/server.ts:590-602`
- 现象：首次 OIDC session 先注册策略版本 `oidc`，随后又用真实 policy version 校验。
- 修复动作：首次 session 只注册一次，并使用当前策略版本；认证 provider 不应写入占位版本。
- 验收标准：首次登录、刷新、策略变更和旧 session 失效场景均有测试。

### [x] P1-07 Staging Mock Auth 必须隔离

- 定位：`src/api/server.ts:732-770`
- 风险：启用 `BI_STAGING_MOCK_AUTH` 时，mock JWKS 和 mock token 接口无需认证，调用者可提交任意租户和角色。
- 修复动作：生产启动硬拒绝该开关；staging 仅绑定内网/loopback，增加管理密钥和速率限制。
- 验收标准：生产配置检测到该开关时启动失败；staging 外网访问接口得到拒绝或无法路由。

## P2：可靠性、隐私与性能

### [x] P2-01 修复请求超时计算和定时器生命周期

- 定位：`src/runtime/request-context.ts:36-47`
- 现象：运算符优先级导致传入的 `timeoutMs` 被忽略，实际恒为 120 秒；完成请求后定时器未清理。
- 修复动作：改为 `input.timeoutMs ?? 120_000`，并在完成/取消时清理 timer 和 abort listener。
- 验收标准：测试环境、生产环境和调用方自定义 timeout 均生效；高并发下无长期 timer 堆积。

### [x] P2-02 数据库成本门禁和查询取消要一致

- 定位：`src/datasource/executors/mysql.ts:106-150`、`src/datasource/executors/postgresql.ts:104-146`
- 现象：MySQL/PostgreSQL 的 `EXPLAIN` 失败会继续执行；`Promise.race` 超时不会取消底层数据库查询。
- 修复动作：生产默认 fail-closed；接入驱动级取消；统一清理 timeout、监听器和连接状态。
- 验收标准：EXPLAIN 权限不足、执行超时、客户端断开后，数据库端没有残留查询，连接池可持续工作。

### [x] P2-03 恢复 TLS 证书校验

- 定位：`src/metadata/live-scanner.ts:73-80`
- 修复动作：移除 `rejectUnauthorized: false`；通过 CA/证书配置统一 TLS；生产禁止隐式跳过验证。
- 验收标准：错误证书连接失败，正确 CA 连接成功，并有 live scanner 集成测试。

### [x] P2-04 生产状态改为持久化

- 定位：`src/bootstrap/production-profile.ts:231-249`、`src/bootstrap/productization-factory.ts:23-45`
- 风险：Session、导出任务、模型注册、元数据审核和部分告警状态使用内存存储，多实例或重启会丢失。
- 修复动作：Session/导出/模型/审核使用 Postgres 或 Redis；启动时强制检查持久化依赖和加密密钥。
- 验收标准：滚动发布、单 pod 重启、跨 pod 查询和审批任务恢复测试通过。

### [x] P2-05 历史结果需要保留期、脱敏和访问审计

- 定位：`src/api/server.ts:453-482`、`src/history/postgres-store.ts:10-27,161-184`
- 风险：查询文本、答案预览和最多 5000 行结果以明文保存，当前没有统一 retention/purge 策略。
- 修复动作：按租户配置保留期；敏感列不入历史；必要时字段级加密；删除和导出历史都写审计。
- 验收标准：自动清理过期记录；租户隔离、删除证明和审计查询均可验证。

### [x] P2-06 接通最小聚合人数保护和 deniedColumns

- 定位：`src/policy/result-policy.ts:173-195`、`src/agent.ts:812-814`、`src/tools/execute_code.ts:65-67`
- 现象：`minAggregationCount` 已实现但调用方未传入；`deniedColumns` 主要用于结果/元数据层，SQL 侧仍可能参与筛选、分组和推断。
- 修复动作：把聚合阈值放进 `AccessPolicy` 并贯穿所有执行路径；禁止 denied column 参与表达式、排序、分组和聚合，除非有明确的安全规则。
- 验收标准：小样本聚合自动降级/拒绝；被拒绝列无法通过 WHERE、GROUP BY、ORDER BY 或 COUNT 推断。

### [x] P2-07 修复元数据同步语义

- 定位：`scripts/sync-metadata.ts:67-74`、`scripts/sync-live-metadata.ts:46,107`
- 修复动作：从当前 alias/collection 读取上一版本文档后再做 diff；live rebuild 不自动混入 demo schema；增加 dry-run 差异和回滚保护。
- 验收标准：无变化同步不触发全量重建；删除字段产生 tombstone；生产索引不出现 demo datasource。

### [x] P2-08 优化缓存、限流和日志

- [x] Redis L2 读取改为请求内 await，避免当前请求总是 cache miss。
- [x] 用版本化 namespace 或 `SCAN` 替代租户失效时的 `KEYS`。
- [x] 限流从单进程内存迁移到 Redis/网关，并同时按租户、用户和接口维度限流。
- [x] 生产日志默认脱敏 SQL、参数、JWT claim 和结果数据。
- 验收标准：多 pod 压测下限流和缓存命中行为一致，日志中不出现敏感值。

## 供应链与部署清单

### [x] P2-09 处理生产依赖告警

- `js-yaml@4.2.0`：升级到至少 `4.3.1`，覆盖 GHSA-52cp-r559-cp3m、GHSA-5p4m-2wfm-xmqj。
- `ini@1.3.0`：升级到至少 `1.3.6`，覆盖 GHSA-qqgx-2p2h-9c37。
- `undici@6.27.0`：升级到至少 `6.28.0`，覆盖当前 Qdrant 链路中的安全告警。
- 确认未使用的 LangChain/Qdrant 直接依赖后移除；升级后重新执行 `pnpm audit --prod`。

### [x] P2-10 提升构建和部署可复现性

- [x] 固定 Node、pnpm、Docker base image 和 GitHub Actions 到 digest/commit。
- [x] CI 使用 `pnpm install --frozen-lockfile`，不要在镜像构建中切换到 `npm install`。
- [x] staging/本地数据库只绑定 loopback，密码从 secret 注入，不写入 compose 默认值。
- [x] 部署脚本增加 host key 校验、制品 checksum/签名和项目范围内的清理规则。
- [x] 增加 `apps/bi-analyst/.gitignore`，排除 `_*.txt`、临时 SQL、运行结果和本地密钥。

## 已完成验证

- [x] `pnpm --dir apps/bi-analyst typecheck`
- [x] `pnpm --dir apps/bi-analyst test:security`：25 个通过
- [x] `pnpm --dir apps/bi-analyst test:unit`：321 个通过，9 个非 unit 场景按测试选择器跳过
- [x] `pnpm --dir apps/bi-analyst test:contract`：24 个通过
- [x] `pnpm --dir apps/bi-analyst test:evaluation`：4 个通过
- [x] `pnpm --dir apps/bi-analyst test:integration:local`：18 个通过
- [x] `pnpm --dir apps/bi-analyst test:e2e:local`：8 个通过（含 413/408/401 body 防护）
- [x] `pnpm --dir apps/bi-analyst test:e2e:staging`：4 个通过（含角色矩阵）
- [x] `pnpm --dir apps/bi-analyst test:integration:services`：23 个通过（Qdrant、MySQL、MariaDB、PostgreSQL）
- [x] `pnpm --dir apps/bi-analyst test:live-db`：20 个通过（含 TLS/CA、MySQL mTLS、只读、row filter 和取消/超时）
- [x] `pnpm --dir apps/bi-analyst build`、`verify:artifact`：114 个生产产物通过边界检查
- [x] staging Docker 镜像真实构建通过：Node 22.14.0、非 root UID 10001、112099186 bytes，镜像内无测试/fixture/demo 数据
- [x] `pnpm audit --prod`：122 个生产依赖，0 个漏洞
- [x] `verify:eval-gate`、`verify:routing`、`verify:llm-eval`、`verify:dialect-cert` 本地门禁通过
- [x] Redis 多实例 Session/导出/模型/元数据恢复测试通过
- [x] 嵌套/派生/相关子查询、注释与字符串混淆行过滤测试通过

## 完成证据（2026-08-18）

- P0/P1/P2 代码、测试和部署配置已提交到当前工作树；生产 Profile 强制 `AUTH_ISSUER`、`AUTH_AUDIENCE`、`REDIS_URL`、审计/历史库和 32+ 字符加密密钥。
- production 的 Session、导出任务、模型 rollout 和元数据审核以 Redis 为权威状态；请求路径使用异步读取，启动与 `/ready` 检查 Redis/状态后端连通性。
- staging compose 的 MySQL/PostgreSQL 端口仅绑定 loopback，密码和 mock admin key 通过必填环境变量注入；Node/Docker 镜像与 GitHub Actions 已固定到 digest/commit。
- Docker Desktop 4.82.0 / Engine 29.6.1 实测可用；`test:integration:services` 23/23、`test:live-db` 20/20 通过，覆盖 Qdrant 索引、真实 schema 扫描、Registry attach、TLS/CA、MySQL mTLS、只读、row filter 和取消/超时。
- 本地 MySQL、MariaDB、PostgreSQL、Qdrant 均固定镜像 digest 且只绑定 `127.0.0.1`；Qdrant 服务端 v1.18.3 与客户端 1.19.0 兼容，未再出现跨 minor 版本警告。
- `docker build -f apps/bi-analyst/docker/staging-acc/Dockerfile -t bi-analyst-staging-acc:verify .` 真实构建通过；镜像运行用户为 `bi`（UID 10001），Node v22.14.0，生产边界检查通过。
- staging-acc 栈实测 `bi-acc-mysql`、`bi-acc-postgres`、`bi-acc-app` 全部 `Healthy`；`/health` 与 `/ready` 均 HTTP 200，readiness 同时报告 MySQL/PG executor、audit、history、checkpointer、cache 和 state 健康。
- 由于 mock-token 保持 loopback-only，验收从应用容器内部取得 JWT，再从宿主机调用 `datasource.sales_mysql` 与 `datasource.analytics_pg` 的 `/api/analyze`，两者均 HTTP 200 且带 `requestId`/`traceId`；JWT + `BI_AUDIT_READER` 查询审计 HTTP 200 且有记录，未带 JWT 请求为 401。
- dialect certification 的云 staging、云 mTLS 证据和 production-certified sign-off 仍是运维/云环境阻塞项，代码门禁明确报告这些 blocker。

## 建议实施顺序

1. P0-01、P0-02：先修复数据隔离和租户授权边界。
2. P1-01 至 P1-05：修复认证、策略加载、请求体和治理权限。
3. P1-06、P1-07 与 P2-01 至 P2-06：补齐会话、持久化、取消、隐私和 TLS。
4. P2-07 至 P2-10：处理元数据正确性、缓存、依赖和部署工程化。


