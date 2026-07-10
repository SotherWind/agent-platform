# web-research

> 状态：**规划中** — 目录已预留，代码尚未开始。

联网深度调研 Agent。面向需要实时信息的场景，通过 Web 搜索、网页抓取与信息聚合，生成带来源引用的调研报告。

## 规划能力

- **Web 搜索**：接入搜索引擎 / 搜索 API（如 Tavily、Exa 等），获取实时网页结果
- **页面抓取与解析**：提取正文、结构化摘要，过滤噪声内容
- **多轮调研**：根据初步结果自动扩展搜索 query，逐步深入
- **报告生成**：汇总多源信息，输出带引用链接的结构化报告
- **来源溯源**：每条结论标注 URL 与抓取时间，支持事实核查

## 规划工作流

```
planQuery → webSearch → fetchPages → synthesize → report
                ↑                              │
                └──── refineQuery ─────────────┘  (信息不足时扩展搜索)
```

## 与其他 Agent 的关系

| 场景 | 调用方 | 说明 |
|------|--------|------|
| 独立调研 | 用户直接提问 | 「帮我调研 XX 行业趋势」 |
| 编排调用 | agent-orchestrator | 复杂任务中需要实时外部信息时路由到此 Agent |
| 补充 RAG | rag-boot | 知识库无覆盖时，联网检索作为 fallback |

## 规划目录结构

```
src/
├── agent.ts           # LangGraph 工作流
├── tools/
│   ├── web-search.ts  # 搜索 API 封装
│   ├── fetch-page.ts  # 网页抓取与解析
│   └── synthesize.ts  # 信息聚合
├── providers/         # 搜索 / 抓取 Provider 抽象
└── report/            # 报告模板与格式化
```

## 规划依赖

- LangGraph / LangChain — Agent 编排
- `@agent-platform/llm-sdk` — LLM 调用
- Web Search API — Tavily / Exa / 自建搜索
- 网页解析 — cheerio / readability

## 环境变量（草案）

```env
# LLM
MODEL_API_KEY=
MODEL_BASE_URL=
MODEL_NAME=

# Web Search
SEARCH_API_KEY=
SEARCH_PROVIDER=tavily   # tavily | exa | custom

# 可选：抓取代理
# FETCH_PROXY=
# MAX_PAGES_PER_QUERY=5
```

## 开发计划

1. 搜索 Provider 抽象 + Tavily/Exa 适配
2. 单轮搜索 → 摘要最小闭环
3. 多轮 query 扩展与报告生成
4. 接入 agent-orchestrator 编排层
