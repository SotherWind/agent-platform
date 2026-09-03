# rag-boot

企业级智能客服 Agent 的 TypeScript + LangGraph 实现，默认采用安全降级和依赖注入，支持多租户 RAG、工具调用、人工交接、评测与治理。

## 本地验证

```bash
pnpm test
pnpm typecheck
pnpm test:cov
pnpm eval
SECURITY_TESTS_PASSED=true pnpm eval:gate
```

`test` 在 Windows 环境使用单 worker 的 threads pool，避免 Vitest 通过 `wmic` 探测进程导致测试退出异常。

## 核心链路

```text
入口鉴权/幂等
  -> 前置拦截与直答
  -> 输入 Guardrails
  -> triage
  -> query rewrite
  -> retrieve -> rerank -> context budget -> confidence
  -> specialist <-> tools
  -> orchestrator -> generate -> reviewer
  -> output / escalation + handoff + ticket
```

- 直接调用公开 `createGraph()` 时必须传入 `authenticated: true`；生产入口应先通过 `AccessGateway`，租户身份从凭证获得。
- `buildGraph()` 默认使用 `MemorySaver`。生产可注入 `SqliteSaver`，并在调用配置中提供 `configurable.thread_id`。
- `reranker` 未配置时默认走向量排序降级；传入 `null` 可显式关闭远程 rerank。
- 所有写工具必须经过 propose/confirm/execute；生成模型永远不能直接触发写副作用。
- 流式公开入口采用“先审后发”：完成 Reviewer 后才按 chunk 发送，避免高风险内容先发后拦。
- MCP 适配层只提供无状态 `tools/call`、MRTR `input_required`/`requestState` 与 W3C Trace Context 接口形状，具体传输由调用方注入。

## 环境变量

真实 LLM 使用：

- `MODEL_API_KEY`
- `MODEL_NAME`（默认 `gpt-4o-mini`）
- `MODEL_BASE_URL`（可选）

Qdrant 使用：

- `QDRANT_URL`
- `QDRANT_API_KEY`（可选）
- `QDRANT_COLLECTION_NAME`（可选）
- `USE_QDRANT=true`

Rerank 使用：

- `RERANK_API_KEY`
- `RERANK_BASE_URL`（可选）
- `RERANK_MODEL`（可选）

评测质量门禁：

- `SECURITY_TESTS_PASSED=true`：表示安全类测试已经通过，门禁才允许通过。
- `HUMAN_BASELINE_RESOLUTION_RATE`：仅在需要输出相对人工 baseline 的 savings 结论时提供。

## 目录说明

- `src/agent.ts`：主 LangGraph 编排图。
- `src/nodes/`：triage、rewrite、检索预算、置信度、专家、编排、生成。
- `src/tools/`、`src/actions/`、`src/tickets.ts`：工具契约、幂等、动作信号、三段分离和工单。
- `src/guardrails/`：输入、动作、输出三点 Guardrails 与 Reviewer。
- `src/eval/`：JSONL fixture 回放、指标、质量门禁。
- `src/observability/`：结构化 tracing、PII 脱敏和留存。
- `docs/architecture-task-checklist.md`：架构任务清单与完成状态。
