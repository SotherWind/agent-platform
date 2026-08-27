# 单机 Staging 验收清单

> 适用：仅一台自有服务器（无 K8s/集群）  
> 项目名隔离前缀：`bi-analyst-staging-acc`（验收结束后只清理此前缀资源）  
> 对应计划：ENTERPRISE-PLAN **v1.19**（单机部署范围）Phase A～E 主路径 + Phase D live  
> 更新日期：2026-07-29

## 0. 验收边界

| 级别 | 含义 | 本清单 |
|------|------|--------|
| L1 应用冒烟 | `APP_ENV=development` 本地 Profile（HeaderAuth + SQLite）跑通 API | **必做**（历史已通过；现默认走 L4） |
| L2 依赖联通 | MySQL / PostgreSQL 容器 health + 应用可连（或 live 探针） | **必做** |
| L3 业务分析 | `POST /api/analyze` 返回答案 / 澄清，审计有事件 | **必做** |
| L4 生产 Profile | `APP_ENV=staging` + JWKS + Qdrant/InMemory + Registry；同一 `dist` | **必做** |

**本轮不在范围（非单机部署任务）**：云集群、`production-certified`、planned 方言 live、多实例 checkpointer HA、跨云密钥 HA；Oracle/SQL Server 真实 live 作为可选扩展，不阻塞本清单。  
单机可用：`BI_ALLOW_ENV_SECRETS`、可选本机 Redis、可选本机 Qdrant。

**单机验收结论**：本清单 L1～L4 的必做任务项全部完成；范围外能力不计入单机部署完成度。

### L4 单机条件（显式开关）

| 变量 | 作用 |
|------|------|
| `BI_SINGLE_MACHINE_STAGING=1` | 启用单机 staging 受控回退（与云 staging 区分） |
| `BI_STAGING_MOCK_AUTH=1` | jose 自签 JWKS + `/api/staging/mock-token` |
| `BI_ALLOW_INMEMORY_RETRIEVER=1` | **无本机 Qdrant 时**允许 InMemory 向量后端（有 `QDRANT_URL` 时优先 Qdrant） |
| `DATASOURCE_REGISTRY_PATH` | YAML Registry（必填） |
| `POLICY_CONFIG_PATH` | 策略 JSON（必填） |
| `BI_ATTACH_LIVE_DATASOURCES=1` | 按 YAML Registry + SecretProvider 挂载 MySQL/PG live 执行器 |
| `AUDIT_DATABASE_URL` | 审计落 PG（验收 compose 指向 `bi-acc-postgres`） |
| `AUDIT_RETENTION_DAYS` | 单机审计 TTL（天） |
| `AUTH_OIDC_DISCOVERY_URL` | 可选：接真实/本机 IdP |

## 1. 前置条件

- [x] SSH：`ssh server` 可用
- [x] Docker：`sudo docker` 可用（当前 `ubuntu` 用户不在 docker 组时用 sudo）
- [x] 磁盘 ≥ 3GB 可用
- [x] 端口未冲突：验收栈使用 **18306 / 18432 / 13000**
- [x] 不触碰已有容器：`ai-photo-edit-server`、`error-sentinel*`、`notification-mcp` 等

## 2. 镜像瘦身要求

- [x] 多阶段构建：builder 含编译工具；runtime 仅 Node + `dist` + 生产依赖
- [x] 不拷贝 `tests/`、`.env`、demo DB、证书私钥工作目录进最终镜像
- [x] 标签：`bi-analyst-staging-acc:app`
- [x] 2026-07-28 clean build 镜像约 **138MB**（历史远端验收镜像 477MB）

## 3. 部署步骤（验收执行）

```bash
ssh server 'mkdir -p ~/bi-analyst-staging-acc && ls ~/bi-analyst-staging-acc'
# 本地：powershell -File apps/bi-analyst/docker/staging-acc/pack-and-deploy.ps1
```

- [x] 上传验收上下文
- [x] `docker compose -p bi-analyst-staging-acc build` / `up -d`
- [x] MySQL / Postgres health
- [x] App health → 200（L4 期望 `environment=staging`）

## 4. 功能验收项

### 4.1 Health（L4）

- [x] HTTP 200（脚本断言）
- [x] `environment` 为 `staging`（2026-07-22 远端验收返回 `staging`）
- [x] body 含 `liveDataSourceIds`：`sales_mysql`、`analytics_pg`

### 4.2 Analyze（JWT mock）

```bash
# mock-token remains loopback-only inside the app container. For a Docker-published
# port, issue it from the app container and use the returned JWT against the host API.
docker exec bi-acc-app node -e "fetch('http://127.0.0.1:3000/api/staging/mock-token',{method:'POST',headers:{'content-type':'application/json','x-bi-staging-admin-key':process.env.BI_STAGING_MOCK_ADMIN_KEY},body:JSON.stringify({subjectId:'user-dev',tenantId:'tenant-1',roles:['analyst','BI_QUERY_DEBUG','BI_AUDIT_READER']})}).then(async r=>process.stdout.write(await r.text()))"
```

- [x] HTTP 200；有 `finalAnswer` 或 `clarification`
- [x] `meta.requestId` / `meta.traceId`（脚本已断言；本地 unit 覆盖）

### 4.3 伪造身份拒绝

- [x] 非 200 → 历史实测 **401**

### 4.4 数据源 + live analyze

- [x] `bi-acc-mysql` / `bi-acc-postgres` / `bi-acc-app` healthy（L1～L3）
- [x] analyze 打到 MySQL / PG：显式 `datasource.sales_mysql` / `datasource.analytics_pg` 均 HTTP 200

### 4.4.1 live schema 审核与 RAG

- [x] `pnpm sync:metadata:live -- --dry-run` 扫描 MySQL/PG 业务表 `users,orders`，默认不写入
- [x] `pnpm sync:metadata:live -- --approve` 显式批准 24 条 live schema，并原子切换 Qdrant alias
- [x] 真实模型 RAG：MySQL/PG 均召回 schema，生成 `SELECT COUNT(*) FROM orders`，live executor 返回 1 行

### 4.5 审计可查

- [x] HTTP 200 且 `items` 非空（JWT + `BI_AUDIT_READER` 查询通过）

### 4.6（可选）澄清选项

- [x] `clarificationChoice=range.last_30d` → 200（历史通过）

## 5. 清理（仅本次验收）

只删 `bi-analyst-staging-acc` / `bi-acc-*` / 验收镜像与 `~/bi-analyst-staging-acc`；**禁止**动无关容器。

```bash
# 或：ssh server 'bash ~/bi-analyst-staging-acc/remote-cleanup.sh'
```

- [x] L1～L4 清理已确认；验收容器、镜像、工作目录已删除，既有业务容器保留

## 6. 通过标准与记录

### 实测（2026-07-16，L1～L3）

| 项 | 结果 |
|----|------|
| 结论 | **ACCEPTANCE PASSED**（`APP_ENV=development`） |
| 镜像 | `bi-analyst-staging-acc:app` **477MB** |
| health / analyze / forged / clarification | 200 / 200 / 401 / 200 |

### L4 最终收口（2026-07-28；远端证据为 2026-07-22）

| 项 | 状态 |
|----|------|
| 代码 / 脚本 / 单测 | **已完成** |
| 本地门禁 | `typecheck` / `build` 通过；unit **310/12**（服务开启时 310/9）；contract **24**；security **25**；evaluation **4**；integration-local **16**；integration-services **23**；live DB **20**；local E2E **6**；staging E2E **3**；artifact **108 文件**；schema eval **4/4**；路由 **20/20**；离线 LLM **5/5**；方言 `localPass=true` |
| CI 门禁 | `.github/workflows/bi-analyst.yml` 包含 `verify`、`integration-services`、`staging-image`；镜像 job 等待前两者，断言无项目测试/demo 内容，并启动 production image 复验 L4 health/analyze/认证/审计 |
| 远端构建 | `pack-and-deploy.ps1` 通过；同一镜像 `bi-analyst-staging-acc:app` **477MB** |
| 远端 L4 | **ACCEPTANCE PASSED**：health 200；`staging`；MySQL/PG live analyze 200；audit 200 且非空 |
| 远端清理 | `remote-cleanup.sh` 通过；`~/bi-analyst-staging-acc`、`bi-acc-*`、验收镜像已清理 |
| 本地运行态 L4 | **ACCEPTANCE PASSED**：2026-07-28 production image health=`staging` 且列出 MySQL/PG；mock-token 200；伪造身份 401；MySQL/PG live analyze 200；request/trace 非空；audit 非空；清理完成 |

### v1.19 运行可靠性补强（2026-07-29）

- [x] `/live` 仅报告进程存活；`/ready` 聚合数据库、执行器和外部依赖，依赖失败返回 503
- [x] Docker healthcheck 使用 `/ready`
- [x] PostgreSQL Audit/History 查询走权威存储，并验证重启后可恢复
- [x] 后台持久化失败写日志并在 flush/close 暴露，关闭前排空
- [x] live executor 的连接配置仅来自 Registry，密码仅经 SecretProvider 解析，失败时阻止启动
- [x] SIGTERM/SIGINT 幂等关闭 HTTP、executor、Redis、History、Audit、Checkpointer 与 SQLite
| Production image | clean build 成功，约 **138MB**；自有 `dist` **108 文件**；不包含 `data/ecommerce.db`、`/app/tests`、项目 fixture 或测试身份内容 |
| 本地真实模型复验 | **PASSED**：真实 `MODEL_BASE_URL` / `MODEL_NAME`；SQLite/MySQL/PG 均 `queryPath=rag`、`cacheHit=false`；schema 经显式批准后被召回；模型生成 SQL；三个 executor 均 `sql.executed` 200 且返回 1 行 |

构建注意：国内机用阿里云 Debian + npmmirror；ESM 用 `scripts/fix-dist-esm-extensions.mjs`。

## 7. 相关文件

| 路径 | 用途 |
|------|------|
| `docker/staging-acc/*` | Dockerfile / compose / accept / cleanup |
| `config/datasources.staging-acc.yaml` | 验收 Registry |
| `config/policies.staging-acc.json` | 验收策略 |
| `docs/ENTERPRISE-PLAN.md` | 企业计划（单机优先） |
| `docs/SUPPORT-STATUS.md` | 产品支持与认证清单 |
