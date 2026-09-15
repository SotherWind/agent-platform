# @agent-platform/rag-bot-web

智能客服前端（React + antd + Vercel AI SDK）。

## 功能（一期：纯对话）

- 登录页：账号密码 → `POST /login` 换 token（localStorage 持久化）
- 聊天页：`useChat` + `DefaultChatTransport`，流式输出、多轮会话（服务端按 threadId 记忆上下文）
- **打字机效果**：`src/components/TypewriterText.tsx` 对"正在流式/最新"的助手消息逐字揭示，
  带闪烁光标；速度按待显示量自适应（落后越多吐得越快），既能跟上流、又不会整段蹦出。
  调节：`charsPerTick`（默认 3 字/20ms ≈ 150 字/秒）与 `tickMs`。
- 新会话：重新生成 threadId
- 登录失效（token 过期 / 服务端重启）：自动检测 401 并回到登录页

## 启动

```bash
# 先启动后端（见 server/rag-bot/README.md）
pnpm --filter @agent-platform/rag-bot-server dev

# 前端
pnpm --filter @agent-platform/rag-bot-web dev
# 打开 http://localhost:5174（Vite 已把 /api、/login、/health 代理到 8787）
```

- 临时连接其他本地 server：`RAGBOT_SERVER_URL=http://127.0.0.1:8788 VITE_PORT=5175 pnpm dev`

## 与后端的约定

- `/api/chat` 走 Vercel AI SDK UI Message Stream 协议（SSE），body 携带
  `{ threadId, messageId }`，鉴权头 `Authorization: Bearer <token>`。
- 一期不发送历史消息（`history: []`），多轮上下文由服务端 checkpointer 按 threadId 维护。
