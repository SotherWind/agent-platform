# bi-analyst

自然语言 BI 问数 Agent。用户用中文或英文提问，系统自动检索相关 Schema、生成只读 SQL、执行查询并输出 ECharts 图表配置。

## 核心能力

- **Text-to-SQL**：LLM 生成只读 SQL，支持 SQL 语法错误自愈重试
- **Schema RAG**：向量检索相关表/字段，裁剪上下文后再交给 LLM
- **图表生成**：bar / line / pie / scatter / table → ECharts option
- **安全治理（原型）**：SQL 只读校验、表 allowlist、列级脱敏、审计日志
- **多环境 Profile**：`development` / `test` 本地全栈；`staging` / `production` 生产构建

## 工作流

```
planner → schemaRag → sqlGenerator → codeInterpreter → chartFormatter
                              ↑              │
                              └── retry ─────┘  (SQL 失败时自愈重试)
```

## 目录结构

```
src/
├── agent.ts           # LangGraph 工作流
├── main.ts            # 启动入口
├── api/server.ts      # HTTP API
├── bootstrap/         # 本地 / 生产 Profile 装配
├── metadata/          # Schema RAG、向量索引
├── datasource/        # SQL 执行器与校验
├── tools/             # generate_sql、execute_code、format_chart
├── policy/            # 访问策略与结果防泄漏
├── auth/              # 身份与会话
├── session/           # SQLite 会话与 Checkpoint
└── audit/             # 审计事件
docs/
└── ENTERPRISE-PLAN.md # 企业级演进计划
```

## 快速开始

### 1. 安装依赖（在 monorepo 根目录）

```bash
pnpm install
```

### 2. 配置环境变量

在 `apps/bi-analyst/` 下创建 `.env`：

```env
APP_ENV=development
PORT=3000

# LLM（OpenAI 兼容）
MODEL_API_KEY=your-api-key
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=your-model

# 可选：向量 Schema RAG（不配置则使用内存 demo retriever）
# QDRANT_URL=http://127.0.0.1:6333
# QDRANT_API_KEY=
# EMBEDDING_BASE_URL=
# EMBEDDING_API_KEY=
# EMBEDDING_MODEL=

MAX_RETRY_COUNT=3
```

### 3. 启动开发服务

```bash
pnpm dev
```

### 4. 构建与生产启动

```bash
pnpm build
pnpm start
```

## API

### 健康检查

```bash
curl http://localhost:3000/health
curl http://localhost:3000/live
curl http://localhost:3000/ready
```

`/health` 与 `/live` 用于存活检查；容器和流量入口应使用 `/ready`，依赖未就绪时返回 HTTP 503。

### 问数分析

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-subject-id: demo-user" \
  -H "x-tenant-id: demo-tenant" \
  -d '{"query": "各城市用户数量", "sessionId": "sess-001"}'
```

响应包含 `finalAnswer`（自然语言解读）、`chartSpec`（ECharts 配置）和 `meta`（traceId、数据新鲜度等）。

## 测试

```bash
pnpm test:unit          # 单元测试
pnpm test:contract      # 契约测试
pnpm test:security      # 安全测试
pnpm test:integration   # 集成测试（需 RUN_INTEGRATION_TESTS=1）
pnpm test:evaluation    # Schema RAG 评测
pnpm test:e2e:local     # 本地 E2E
```

## 其他脚本

```bash
pnpm index:metadata     # 将 demo Schema 索引到 Qdrant
pnpm verify:artifact    # 校验生产构建产物
pnpm verify:routing     # 多数据源 Top-1 路由门禁
pnpm verify:llm-eval    # 20 条 Text-to-SQL golden；可要求真实模型不得跳过
pnpm typecheck          # TypeScript 类型检查
```

## 数据源配置

参考 `config/datasources.example.yaml` 配置数据源（复制为 `config/datasources.yaml`，该文件已在 `.gitignore` 中忽略）。

本地开发默认使用 SQLite 演示库（`data/ecommerce.db`，首次启动自动 seed）。

`staging` / `production` 的 production artifact 不创建、seed 或打包该演示库。单机部署需要 SQLite 时，由运维把已有数据库文件挂载到容器/主机，并在 Registry 的 `connection.filePath` 中填写该文件的绝对路径；运行时只读打开且要求文件已存在。默认 `config/datasources.staging-acc.yaml` 仅启用 MySQL 与 PostgreSQL。

部署运行时以 YAML Registry 作为连接配置的唯一来源。MySQL/PostgreSQL 的 `connection` 必须提供 `host`、`port`、`user`、`database` 和 `secretRef`；密码只通过 `SecretProvider` 解析，连接失败会直接阻止启动。

## 当前状态

单机部署主路径已完成收口；云、集群、真实 Oracle/SQL Server live 与 `production-certified` 仍在当前范围外。详细状态见 [docs/ENTERPRISE-PLAN.md](./docs/ENTERPRISE-PLAN.md) 和 [docs/SUPPORT-STATUS.md](./docs/SUPPORT-STATUS.md)。

## 依赖

- `@agent-platform/llm-sdk` — 共享 LLM 封装
- LangGraph / LangChain — Agent 编排
- better-sqlite3 — 本地 SQLite
- @langchain/qdrant — 向量 Schema 检索（可选）

## 生产状态与部署

生产环境的 `Session`、导出任务、模型 canary/回滚和元数据审核状态以 `REDIS_URL` 为权威存储，启动时会检查 Redis 连通性；`AUDIT_DATABASE_URL`（或 `HISTORY_DATABASE_URL`）、`HISTORY_ENCRYPTION_SECRET` 和 `EXPORT_ENCRYPTION_SECRET` 也是生产必需项。滚动发布时各实例从 Redis 读取同一份状态，导出 CSV 在写入 Redis 前使用 AES 加密。

单机 staging 可使用 `STATE_VOLUME_PATH` 和 SQLite/JSON 文件回退，但这不是生产多实例配置。staging mock token 接口仅监听 loopback，并要求 `BI_STAGING_MOCK_ADMIN_KEY` 请求头。

企业分析闭环接口：

- `POST /api/feedback`、`GET /api/feedback`：记录答案评价和人工修正；`BI_EVAL_REVIEWER` 可按租户读取并通过 `GET /api/feedback/replay` 导出回放集。
- `GET /api/semantic/metrics`：读取已认证指标；管理员可加 `governance=1` 查看版本、依赖和生命周期校验结果。
- `POST /api/analyze/jobs`、`GET/POST /api/analyze/jobs/:jobId[/cancel]`：提交、查询和取消可持久化异步分析任务。
- `GET /api/metrics`：在原有 SLO 快照之外返回内置 Telemetry span/counter/gauge；设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 可异步导出 trace。
