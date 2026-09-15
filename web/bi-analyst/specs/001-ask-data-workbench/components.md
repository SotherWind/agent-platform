# 组件契约

每个展示组件一个目录。禁止展示组件 `fetch` 问数接口。禁止把业务细节写进 `AskDataPage` 以外的编排层。

## SessionRail

- 职责：品牌字、本机线程列表、「新会话」、健康点、sessionId。
- props：`threads`, `activeId`, `sessionId`, `health`, `onNew`, `onSelect`
- 禁止：发问数请求；调用 `/api/history`

## WorkbenchHeader

- 职责：标题「问数工作台」、当前会话摘要。
- props：`sessionId`

## MessageList

- 职责：按消息顺序渲染 UserBubble / AssistantTurn。
- props：`messages`, `onClarification`, `clarificationDisabled`

## UserBubble

- 职责：用户问句。
- props：`text`

## AssistantTurn

- 职责：组装一轮助手 parts。
- props：`parts`, `onClarification`, `clarificationDisabled`
- 禁止：调 API

## PipelineStatus

- 职责：五步进度（解析问题 → 检索表结构 → 生成 SQL → 执行查询 → 生成图表）。
- props：`pipeline`
- 禁止：假装 token 流

## AnswerBody

- 职责：`finalAnswer` 文本，保留换行。
- props：`text`

## ChartPanel

- 职责：`chartSpec.option` 用 ECharts；`type === "table"` 用 antd Table。
- props：`spec`
- 禁止：改写业务数据；无 option/dataset 时不渲染空框

## ClarificationBar

- 职责：问题 + 选项按钮。
- props：`clarification`, `disabled`, `onSelect`
- 事件：只抛 `{ id, label }`，不改 query

## Composer

- 职责：输入、发送、停止。Enter 发送，Shift+Enter 换行。
- props：`status`, `onSend`, `onStop`
- 禁止：持有历史消息

## EmptyState

- 职责：四条示例问句。
- props：`examples`, `onPick`
- 事件：只回调 query 字符串
