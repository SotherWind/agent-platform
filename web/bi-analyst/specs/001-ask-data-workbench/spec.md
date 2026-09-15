# 001 问数工作台

## 背景

分析师用自然语言向 `apps/bi-analyst` Agent 提问。本期只做核心问数页，对接已有 `POST /api/analyze/stream`。

## 用户

本地开发中的分析师（HeaderAuth：`user-dev` / `tenant-1`）。在办公灯光下连续追问同一份零售演示数据。

## 用户故事

1. 打开页面即可提问，不必先登录。
2. 发送中文问题后，能看到图节点进度，然后看到文字解读和图表。
3. Agent 需要澄清时，点选项继续，而不是把选项文案当成新问题。
4. 可以停止正在进行的分析。
5. 能看出后端是否可达。
6. 能新开本机会话（不调用 `/api/history`）。

## 范围

- 对话输入、流式进度、文字回答、ECharts / 表格、澄清选项、停止、健康检查
- 左侧会话栏：本机 `localStorage` 线程列表与「新会话」
- Vite 开发代理到 `http://127.0.0.1:3000`

## 非目标

- `/api/history`、反馈、CSV 导出、元数据治理
- JWT / OIDC 登录
- 根目录 `server/` 或新的 `/api/chat` 协议端点
- 根目录 CORS 改造

## 验收标准

- [ ] 空态展示 4 条示例问句；点击后作为 `query` 发送
- [ ] 发送后出现 pipeline 步骤，随后出现 `finalAnswer`；有 `chartSpec` 时渲染图或表
- [ ] 澄清选项点击后请求体为原 `query` + `clarificationChoice`，用户气泡显示选项 `label`
- [ ] 流式中「停止生成」中断请求
- [ ] 顶栏/侧栏显示会话 id；健康检查反映 `/health`
- [ ] 「新会话」清空当前对话并换新 `sessionId`
- [ ] 展示组件不直接 `fetch` `/api/analyze/stream`

## 视觉合同

接受概念图：[concept.png](./concept.png)
