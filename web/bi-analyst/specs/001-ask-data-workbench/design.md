# 设计

## 场景

分析师坐在冷白 LED 办公灯下问数。界面是账本式工作台，不是营销页，也不是监控大屏。

## 视觉

- 策略：Restrained。纯白主区 + 近黑侧栏 + 绯红主操作。
- 接受概念：左侧深色会话栏，右侧白底消息列，底栏输入，绯红「发送问题」。
- 品牌种子：`oklch(0.48 0.175 10)`（绯红，hue ~10°）。
- 背景：主区 `oklch(1 0 0)`；侧栏 `oklch(0.16 0.028 255)`。
- 禁止：奶油底、紫雾、玻璃拟态、左侧色条卡片、渐变字。

## 架构

```
AskDataPage
  SessionRail          本机线程 + 健康状态
  WorkbenchHeader      问数工作台 + sessionId
  MessageList
    UserBubble
    AssistantTurn
      PipelineStatus
      AnswerBody
      ChartPanel
      ClarificationBar
  EmptyState           无消息时
  Composer
```

展示组件只收 props。`useAskDataChat` 持有 `useChat` + Transport。`BiAnalyzeChatTransport` 把现有 SSE 转成 `UIMessageChunk`。

## API 映射

| 前端 | 后端 |
|---|---|
| `POST /api/analyze/stream` | `{ query, sessionId, clarificationChoice? }` |
| Header | `x-subject-id`, `x-tenant-id` |
| SSE `status` / `node` | `data-pipeline` |
| SSE `answer.finalAnswer` | `text-*` |
| SSE `answer.chartSpec` | `data-chart` |
| SSE `clarification` | `data-clarification` |
| SSE `error` | `{ type: "error" }` |
| `GET /health` | 侧栏连接状态 |

禁止新增请求体身份字段（`userId` / `tenantId` / `roles`）。

## 澄清

选项点击发送用户气泡 `label`，Transport 使用 `body.query`（上一轮分析问句）+ `body.clarificationChoice`。

## 会话

- `sessionId`：`localStorage`，随「新会话」轮换。
- 线程列表：本机快照，最多 30 条；不是 `/api/history`。

## 开发代理

Vite `:5173` 将 `/api`、`/health` 代理到 `:3000`。
