# rag-boot

知识库 RAG 检索 Agent。基于 LangGraph 编排向量检索、重排序与答案生成，支持多租户隔离与 Langfuse 可观测性。

## 核心能力

- **向量检索**：Qdrant 存储，按 `tenantId` 过滤，Fail-closed 拒绝无租户请求
- **重排序（Rerank）**：检索结果二次排序，提升 Precision
- **文档入库**：支持 Markdown 文件切分（按 `##` 标题）与通用文本切分
- **引用溯源**：生成答案时附带 citations 来源片段
- **可观测性**：集成 Langfuse tracing

## 工作流

```
retrieve → rerank → generate
```

| 节点 | 职责 |
|------|------|
| retrieve | 向量相似度检索，tenant 过滤 |
| rerank | 对 Top-K 结果重排序，取 Top-N |
| generate | 基于重排结果生成答案 + citations |

## 目录结构

```
src/
├── index.ts        # 对外导出 createGraph
├── agent.ts        # LangGraph 工作流
├── vectorstore.ts  # Qdrant 向量库封装
├── embeddings.ts   # Embedding 工厂
├── rerank.ts       # Rerank API 封装
├── tools.ts        # retrieveContext 工具
├── observability.ts # Langfuse tracing
├── schema.ts       # Zod 类型定义
└── state.ts        # Agent 状态
```

## 快速开始

### 1. 安装依赖（在 monorepo 根目录）

```bash
pnpm install
```

### 2. 配置环境变量

在 `apps/rag-boot/` 下创建 `.env`：

```env
# LLM
MODEL_API_KEY=your-api-key
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=your-model

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION_NAME=rag_boot

# Embedding（OpenAI 兼容）
EMBEDDING_API_KEY=your-embedding-key
EMBEDDING_BASE_URL=https://api.example.com/v1
EMBEDDING_MODEL=your-embedding-model

# Rerank API（可选，不配置则使用 Mock Rerank）
# RERANK_API_KEY=
# RERANK_BASE_URL=
# RERANK_MODEL=

# Langfuse（可选）
# LANGFUSE_PUBLIC_KEY=
# LANGFUSE_SECRET_KEY=
# LANGFUSE_BASE_URL=
```

### 3. 启动

```bash
pnpm dev
```

## 编程式调用

```ts
import { createGraph } from "./src/index.js";

const graph = createGraph();

const result = await graph.invoke({
  query: "什么是 RAG？",
  tenantId: "tenant-001",
  history: [],
});

console.log(result.answer);   // 生成的回答
console.log(result.sources);  // 引用来源片段
```

### 流式调用

```ts
const stream = await graph.stream({
  query: "解释向量检索原理",
  tenantId: "tenant-001",
  history: [],
});

for await (const chunk of stream) {
  console.log(chunk);
}
```

## 文档入库

通过 `VectorStoreType` 接口入库：

```ts
import { createVectorStore } from "./src/vectorstore.js";

const store = await createVectorStore();

await store.ingestFile("./docs/guide.md", {
  tenantId: "tenant-001",
  documentId: "guide-v1",
  source: "internal-docs",
  splitBySection: true,  // Markdown 按 ## 标题切分
});
```

## 多租户安全

- 检索时必须提供 `tenantId`，缺失则直接拒绝
- 生成阶段二次过滤 citations，防止跨租户数据泄漏
- 向量 metadata 中携带 `tenantId`，检索时强制过滤

## 当前状态

RAG 核心链路已实现，适合作为知识检索 Agent 的基础模块。后续将与 **web-research** 和 **agent-orchestrator** 集成。

## 依赖

- LangGraph / LangChain — Agent 编排
- @langchain/qdrant — 向量存储
- langfuse-langchain — 可观测性
