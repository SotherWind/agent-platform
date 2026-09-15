# @agent-platform/rag-bot-server

智能客服 HTTP 薄壳服务。**只做协议翻译，不含业务逻辑**：

```
HTTP（本包）→ AccessGateway（鉴权/幂等/限流）→ rag-boot 图（apps/rag-boot 纯库）
```

核心库不知道 HTTP 的存在；未来换框架（Hono/Express）、加渠道（Webhook/MCP）只动本包。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 探活 |
| POST | `/login` | 账号密码换 token（人）。body: `{username, password}` |
| POST | `/api/chat` | 对话（UI Message Stream SSE）。Header: `Authorization: Bearer <token>`；body: `{messages, threadId, messageId}` |
| OPTIONS | * | CORS 预检（`CORS_ORIGIN` 控制） |

- `/api/chat` 响应为 Vercel AI SDK 标准 UI Message Stream（`data: {...}` + `data: [DONE]`），
  前端 `DefaultChatTransport` 可直接消费。
- 租户身份只来自 token（body 中的 tenantId 一律忽略——rag-boot AccessGateway 安全底线）。
- 系统接入无需登录：在 `RAGBOT_SYSTEM_TOKENS` 配发 token 即可（API Key 语义）。

## 快速开始

```bash
# Node 运行时固定为 22.14.0；better-sqlite3 是原生模块，切换 Node 后必须重装依赖
nvm use
pnpm install

# 0) 准备 Qdrant（可选；不配置时检索为空、图可直答）
qdrant.exe   # 默认 6333 端口

# 1) 配置环境（只配这一处即可，不用配两遍）
cp .env.example .env
#    填 MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME / EMBEDDING_*
#    或设 USE_FAKE_LLM=true 体验演示模式（固定话术，零外呼）
#    修改 RAGBOT_USERS 设置自己的登录账号
#
#    已经在 apps/rag-boot/.env 里配过模型 key 的：无需重复填写，
#    server 启动会自动回退读取它补缺（server/.env 优先级更高，Shell 变量最高）。

# 2) 启动
pnpm --filter @agent-platform/rag-bot-server dev
```

服务启动前会用内存 SQLite 做一次原生运行时探测。若依赖是用其他 Node
版本编译的，服务会直接给出 ABI 不匹配和重装提示，不会打开业务数据库。

启动时会自动检测 Qdrant collection：为空则把 `knowledge/` 下的 `.md` 文档灌入每个已知租户。

## 开发环境 CRM 模拟

开发环境未配置 `RAGBOT_BUSINESS_MODULE` 时，server 默认加载
`LocalCrmAdapter`。它不是“收到请求就返回成功”的 fake，而是与 checkpoint、工单、
proposal 和 action signal 共用 `RAGBOT_DATA_DIR/ragbot.sqlite` 的持久化业务模拟器：

- `crm_accounts`、`crm_orders`、`crm_integrations` 保存账户、订单和集成当前状态。
- 退款、套餐变更、凭证重置在 SQLite 事务中写入业务表，并用 `operationKey` 保存 CRM 自己的幂等账本。
- 订单采用 `(tenant_id, order_id)` 复合主键；所有读取和写入都必须带会话租户。
- `order-demo-private` 只属于 `tenant-demo`；`order-demo-refund` 在两个租户各有一条，状态刻意不同，便于验收隔离。
- `order-demo-refund` 初始金额为 `29900` 分，可用 `propose_refund` 验证确认、signal 投递、退款和重启恢复。

这套模拟器只用于本地联调和架构验收，不代表真实支付扣款或 CRM 的跨系统恰好一次。
生产环境必须配置 `RAGBOT_BUSINESS_MODULE`，由真实业务适配器实现同样的租户归属校验、
事务幂等、下游回执和失败重试语义。

## 流式输出与终审语义（T9.5）

`/api/chat` 默认先审后发：完整执行图、完成终审与持久化后，再发送文本片段。客户端断开不会中止已开始的核心执行。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `REVIEW_STREAM_MODE` | `strict` | 生产只能选 `strict`；`chunked`/`async` 保留开发兼容协议，当前收集完整图后重放事件，不提供首 token 延迟优势 |
| `SPECIALIST_POLICY` | `always` | `skipSingleCategory`=单类别查询跳过 specialist/orchestration，省一次串行 LLM 调用（首字延迟显著下降） |
| `STREAM_CHUNK_SIZE` / `STREAM_CHUNK_DELAY_MS` | `12` / `22` | 传输层打字机节奏（句末标点自动加长停顿） |

生产不会发出终审未通过的模型草稿。`data-replace` 只用于开发兼容模式；撤回不能消除用户已经看见的内容。另见 `scripts/latency-probe.ts`。

## 生产装配

- `NODE_ENV=production` 必须配置 `RAGBOT_DATA_DIR`、至少 32 字节的独立 `RAGBOT_PROPOSAL_SECRET`、`RAGBOT_BUSINESS_MODULE`、真实模型和可用的 Qdrant；假模型、假 embedding、非 strict 模式会阻止启动。
- 开发也默认使用 `./data/ragbot.sqlite`。SQLite 保存 checkpoint、消息与工具幂等租约、线程身份、工单、确认单、动作信号和知识发布记录。所有读取/写入知识的程序必须共享同一发布记录及 collection 名称。
- `RAGBOT_BUSINESS_MODULE` 是管理员配置的本地模块路径，导出 `createTools({ ticketService })`，返回符合 `AgentTool[]` 契约的真实工具。工具必须按 `ToolContext.tenantId/principal` 校验业务对象归属，并在业务事务中用 `ToolContext.operationKey` 去重。不能只配置一个“收到就返回成功”的 handler。
- 用户确认绕过模型，读取权威 proposal 参数后入队，状态为 `queued`；每 5 秒的投递循环恢复漏写的 outbox、重试待处理/失败/租约过期的动作，真实后端成功后才更新 `executed`/`acked`。
- 已完成的 `messageId` 重试会重放原回复；处理中返回 `409 + Retry-After`，参数变化或线程归属冲突返回 `409`。保持相同 `messageId`、`threadId` 和请求内容重试。
- `RAGBOT_KNOWLEDGE_SCOPES` 从服务端配置产品、区域、角色、权限；文档 `metadata.products/regions/roles` 任一匹配即可，`metadata.permissions` 必须全部满足。无授权只能访问租户内无额外限制的文档。
- 替换知识先完整写入不可见 generation，再原子切换发布记录，最后清理旧向量；embedding 维度冲突会报错，绝不自动删除 collection。SQLite 必须与 Qdrant 一起备份。
- 生产默认关闭自动灌库。发布流程应先审核知识内容与授权元数据，再调用注入了共享 publication store 的向量库。

升级前请新建测试会话：旧线程没有身份绑定记录，或凭证权限发生变化时，不应沿用旧线程读取历史数据。旧版已签发的确认令牌不兼容 HMAC 格式，需要重新生成确认单。

## 测试

```bash
# 单元/契约测试：鉴权、协议、工单、评价、租户隔离、生产配置与重试
pnpm --filter @agent-platform/rag-bot-server test

# 一键冒烟（需 server 已在 8787 运行；真实 LLM 模式下单轮约 10-30s）
node node_modules/tsx/dist/cli.mjs scripts/smoke-test.ts

# 真实模型连续两次动态订单查询的子进程回归（需要 server/.env 的真实模型配置）
pnpm repro:crash
```

冒烟覆盖：探活 → 登录 → 未认证拦截 → 知识问答（引用来源）→ 转人工建单 → 工单列表（DTO 清洗）→ 评价回流 → 非法评分拦截，共 8 项。

逐节点延迟定位：`node node_modules/tsx/dist/cli.mjs scripts/latency-probe.ts "问题"`。

## 上线前边界

- 已签发 token 存内存：服务重启后需重新登录（系统 token 不受影响）。
- SQLite 装配适用于单机持久卷及同机多进程，不等于跨主机高可用；跨主机需共享事务存储适配器。租户限流仍为进程内计数。
- 下游必须在业务事务中持久化幂等键。应用侧租约不能单独保证跨系统副作用恰好一次。
- 真正 CRM/支付接入、渠道验签、附件 SSRF/恶意文件扫描、审计日志集中归档及留存任务仍需部署联调。
- 知识失败批次或旧版本清理失败时不再可检索，但物理残留向量仍需运维清理。发布记录缺失时带 generation 的文档会被拒绝检索，不能通过删记录恢复。
- 12 条离线 fixture 不代表生产解决率，满意度仍需真实会话数据验收。
