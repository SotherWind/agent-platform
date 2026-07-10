# @agent-platform/llm-sdk

LangChain `ChatOpenAI` 工厂封装，面向 OpenAI 兼容 LLM 服务。相同 base URL、model、API Key 的连接自动缓存复用，避免重复创建底层连接。

被 `bi-analyst` 等子项目通过 workspace 依赖引用。

## 安装

在 monorepo 内已作为 workspace 包引用：

```json
{
  "dependencies": {
    "@agent-platform/llm-sdk": "workspace:*"
  }
}
```

## 用法

```ts
import { getLLM } from "@agent-platform/llm-sdk";

const defaultModel = getLLM();
const defaultModelWithConfig = getLLM({ temperature: 0 });
const miniModel = getLLM("mini", { temperature: 0 });
const visionModel = getLLM("vision");
const customModel = getLLM({
  model: "glm-4.5-air",
  apiKey: process.env.MODEL_API_KEY,
  configuration: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
  },
  maxRetries: 2,
});
```

相同 base URL、model、API Key 的连接复用同一个 `ChatOpenAI` 实例。`temperature`、`maxTokens`、`tools`、`response_format` 等参数作为默认调用选项存储，不会额外创建连接。

## 环境变量

推荐配置：

```env
MODEL_API_KEY=your-api-key
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=default-model

MODEL_MINI_API_KEY=your-mini-api-key
MODEL_MINI_BASE_URL=https://api.example.com/v1
MODEL_MINI_NAME=mini-model

MODEL_VISION_API_KEY=your-vision-api-key
MODEL_VISION_BASE_URL=https://api.example.com/v1
MODEL_VISION_NAME=vision-model
```

`MODEL_MINI_API_KEY` 和 `MODEL_VISION_API_KEY` 可省略（与 `MODEL_API_KEY` 相同时）。
`MODEL_MINI_BASE_URL` 和 `MODEL_VISION_BASE_URL` 可省略（与 `MODEL_BASE_URL` 相同时）。

## 缓存控制

```ts
import {
  clearLLMCache,
  getLLMCacheSize,
  getLLM,
  removeLLMCache,
} from "@agent-platform/llm-sdk";

const model = getLLM({
  model: "glm-4.5",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  cacheTtlMs: 10 * 60 * 1000,
});

console.log(getLLMCacheSize());
removeLLMCache({
  model: "glm-4.5",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
});
clearLLMCache();
```

## 构建与测试

```bash
pnpm build
pnpm test
```

## API 概览

| 函数 | 说明 |
|------|------|
| `getLLM()` | 获取默认模型实例 |
| `getLLM("mini")` | 获取 mini 模型实例 |
| `getLLM("vision")` | 获取 vision 模型实例 |
| `getLLM({ ... })` | 自定义参数创建实例 |
| `getLLMCacheSize()` | 当前缓存连接数 |
| `removeLLMCache({ ... })` | 移除指定缓存 |
| `clearLLMCache()` | 清空全部缓存 |
