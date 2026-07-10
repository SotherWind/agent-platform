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
```

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
pnpm typecheck          # TypeScript 类型检查
```

## 数据源配置

参考 `config/datasources.example.yaml` 配置数据源（复制为 `config/datasources.yaml`，该文件已在 `.gitignore` 中忽略）。

本地开发默认使用 SQLite 演示库（`data/ecommerce.db`，首次启动自动 seed）。

## 当前状态

项目处于 **prototype** 阶段，核心链路可运行，但多数模块尚未达到生产认证。详细演进计划见 [docs/ENTERPRISE-PLAN.md](./docs/ENTERPRISE-PLAN.md)。

## 依赖

- `@agent-platform/llm-sdk` — 共享 LLM 封装
- LangGraph / LangChain — Agent 编排
- better-sqlite3 — 本地 SQLite
- @langchain/qdrant — 向量 Schema 检索（可选）
