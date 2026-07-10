# agent-orchestrator

> 状态：**规划中** — 目录已预留，代码尚未开始。

多 Agent 编排系统。作为统一入口，根据用户意图将任务路由、分解并调度到专项 Agent（BI 问数、RAG 检索、联网调研），汇总各 Agent 结果返回最终答案。

## 规划能力

- **意图识别与路由**：判断用户问题应交给哪个（或哪些）专项 Agent
- **任务分解**：复杂问题拆分为子任务，并行或串行调度
- **Agent 间协作**：如「先联网调研行业数据，再查内部 BI 对比」
- **结果聚合**：合并多个 Agent 的输出，生成统一回复
- **会话管理**：跨 Agent 共享上下文与 traceId

## 架构

```
用户请求
    │
    ▼
┌─────────────────────────────────┐
│        agent-orchestrator        │
│  planner → router → aggregator   │
└──────────┬──────────┬───────────┘
           │          │          │
     ┌─────▼───┐ ┌────▼────┐ ┌──▼──────────┐
     │bi-analyst│ │rag-boot │ │web-research │
     │ BI 问数  │ │知识检索  │ │ 联网调研    │
     └─────────┘ └─────────┘ └─────────────┘
```

## 路由策略（草案）

| 用户意图示例 | 路由目标 |
|-------------|---------|
| 「各城市销售额趋势」 | bi-analyst |
| 「产品手册里怎么配置 XX」 | rag-boot |
| 「调研 2026 年 AI Agent 市场」 | web-research |
| 「对比行业均值和我们内部数据」 | web-research → bi-analyst |
| 「根据文档和最新新闻总结 XX」 | rag-boot + web-research |

## 规划工作流

```
intake → intentClassifier → taskPlanner → agentDispatch → resultAggregator → response
                                    │
                                    ├── bi-analyst.invoke()
                                    ├── rag-boot.invoke()
                                    └── web-research.invoke()
```

## 规划目录结构

```
src/
├── agent.ts              # 主编排 LangGraph
├── router/
│   ├── intent-classifier.ts
│   └── task-planner.ts
├── adapters/
│   ├── bi-analyst.ts     # 调用 bi-analyst API / Graph
│   ├── rag-boot.ts       # 调用 rag-boot Graph
│   └── web-research.ts   # 调用 web-research Graph
├── aggregator/           # 多 Agent 结果合并
└── session/              # 跨 Agent 会话状态
```

## 与其他项目的关系

| 项目 | 集成方式 |
|------|---------|
| bi-analyst | HTTP API (`POST /api/analyze`) 或直接 import Graph |
| rag-boot | import `createGraph()` 编程式调用 |
| web-research | import Graph 或 HTTP API（待实现） |
| llm-sdk | 编排层自身的 LLM 调用（意图分类、任务规划） |

## 环境变量（草案）

```env
APP_ENV=development
PORT=4000

# 编排层 LLM
MODEL_API_KEY=
MODEL_BASE_URL=
MODEL_NAME=

# 子 Agent 地址
BI_ANALYST_URL=http://localhost:3000
RAG_BOOT_MODE=inline          # inline | remote
WEB_RESEARCH_MODE=inline      # inline | remote
```

## 开发计划

1. 意图分类 + 单 Agent 路由（最小闭环）
2. 接入 bi-analyst 与 rag-boot
3. 多 Agent 串行 / 并行调度
4. 接入 web-research，实现跨场景协作
5. 统一 API 入口与会话管理
