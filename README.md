# agent-platform

基于 LangChain / LangGraph 的 AI Agent 训练与实践 monorepo，采用「专项 Agent + 统一编排」架构，覆盖数据分析、知识检索、联网调研三类场景。

## 项目结构

```
agent-platform/
├── apps/
│   ├── bi-analyst/          # BI 问数 Agent（Text-to-SQL + 图表）
│   ├── rag-boot/            # RAG 检索 Agent
│   ├── web-research/        # 联网研究 Agent（规划中）
│   └── agent-orchestrator/  # 多 Agent 编排系统（规划中）
├── packages/
│   └── llm-sdk/             # 共享 LLM SDK（OpenAI 兼容 + 连接缓存）
├── pnpm-workspace.yaml
└── package.json
```

## 子项目概览

| 项目 | 状态 | 说明 |
|------|------|------|
| [bi-analyst](./apps/bi-analyst) | 开发中 | 自然语言 BI 问数：Schema RAG、Text-to-SQL、ECharts 可视化 |
| [rag-boot](./apps/rag-boot) | 开发中 | 知识库 RAG：向量检索、重排序、多租户隔离 |
| [web-research](./apps/web-research) | 规划中 | 联网深度调研：Web 搜索、信息聚合与报告生成 |
| [agent-orchestrator](./apps/agent-orchestrator) | 规划中 | 多 Agent 编排：串联问数、检索、联网研究 |
| [@agent-platform/llm-sdk](./packages/llm-sdk) | 可用 | LangChain ChatOpenAI 工厂与连接缓存 |

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 9

### 安装依赖

```bash
pnpm install
```

### 运行子项目

```bash
# BI 问数 Agent
cd apps/bi-analyst
# 创建 .env 并按 README 配置环境变量
pnpm dev

# RAG 检索 Agent
cd apps/rag-boot
# 创建 .env 并按 README 配置环境变量
pnpm dev
```

各子项目的详细说明、环境变量与 API 文档见对应目录下的 README。

## 技术栈

- **语言**：TypeScript (ESM)
- **包管理**：pnpm workspace
- **Agent 框架**：LangChain、LangGraph
- **向量库**：Qdrant
- **本地数据库**：SQLite (better-sqlite3)
- **LLM**：OpenAI 兼容 API（通过 `@agent-platform/llm-sdk` 统一接入）

## 架构愿景

```
                    ┌─────────────────────┐
                    │  agent-orchestrator │
                    │   多 Agent 编排层    │
                    └──────────┬──────────┘
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
   │  bi-analyst   │  │   rag-boot    │  │ web-research  │
   │  BI 问数分析   │  │  知识库检索    │  │  联网深度调研  │
   └───────────────┘  └───────────────┘  └───────────────┘
           │                   │                   │
           └───────────────────┴───────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  @agent-platform/   │
                    │      llm-sdk        │
                    └─────────────────────┘
```

## License

ISC
