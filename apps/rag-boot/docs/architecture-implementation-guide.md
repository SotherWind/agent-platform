# rag-boot 架构方案实现详解（面试版）

> 目标读者：要在面试中把这个项目讲清楚、并且扛住多轮追问的人。
> 本文每一节都按 **「反面模式 / 为什么需要 → 做法 → 代码落点 → 关键细节 → 追问预判」** 展开，
> 代码落点精确到文件与函数，便于面试前按图索骥复核。
>
> 规模参考（用于开场自我介绍）：TypeScript + LangGraph 单包实现，
> 测试分为核心单元测试、真实 SQLite 恢复测试、安全专项和 HTTP 契约测试，
> 6 类专家评测集共 12 条 JSONL fixture。数量和验证结果以架构任务清单的复核记录为准，
> 离线回归通过不等于生产质量达标。

---

## 目录

- [0. 三十秒开场：这个项目是什么](#0-三十秒开场这个项目是什么)
- [1. 总体架构与依赖倒置](#1-总体架构与依赖倒置)
- [2. 编排骨架（P1）](#2-编排骨架p1)
- [3. 检索链路（P2）](#3-检索链路p2)
- [4. 工具层（P3）](#4-工具层p3)
- [5. Guardrails 三点拦截（P4）](#5-guardrails-三点拦截p4)
- [6. 人机协同（P5）](#6-人机协同p5)
- [7. 降级与成本（P6）](#7-降级与成本p6)
- [8. 评测闭环（P7）](#8-评测闭环p7)
- [9. 可观测与治理（P8）](#9-可观测与治理p8)
- [10. 渠道与接入层（P9）](#10-渠道与接入层p9)
- [11. 地基：状态、错误、持久化（P0）](#11-地基状态错误持久化p0)
- [12. 多轮追问剧本（重点）](#12-多轮追问剧本重点)
- [13. 六个「发现并修掉死代码」的真故事](#13-六个发现并修掉死代码的真故事)
- [14. 已知短板与下一步](#14-已知短板与下一步)

---

## 0. 三十秒开场：这个项目是什么

**一句话**：一个面向企业客服场景、以「安全降级 + 依赖注入 + 可评测闭环」为设计约束的
TypeScript/LangGraph 智能客服 Agent，覆盖多租户 RAG、工具调用、三段式写操作确认、
人工交接、成本预算与质量门禁。

**它解决的不是「怎么调 LLM」，而是「怎么让 LLM 进到生产系统里不出事」。**
具体四类事故，每一类都对应一个具体的架构约束：

| 事故 | 本项目的约束 | 落点 |
| --- | --- | --- |
| 模型一句话就把钱退了 | 生成模型永远不能直接触发写副作用 | T5.3 三段分离 + T3.1 工具契约 |
| 跨租户读到别人的知识库 | 租户身份不可伪造 + 三层纵深防御 | T9.2 / T2.3 |
| 线上模型挂了整个客服停摆 | 任何单点故障下仍有响应 | T6.1 降级链 |
| 汇报「拦截了 70% 工单」但用户问题没解决 | 主指标是 resolution rate 不是 deflection | T7.2 / T5.4 |

**核心链路**（`src/agent.ts` 的 `buildGraph`）：

```
turnStart（租户 fail-closed + 情绪打分 + 轮次计数）
  → prefilter（零模型直答/拦截）
  → guardrails（输入侧：注入剥离 / PII 脱敏）
  → triageDecision（规则前置 + 小模型分类）
  → rewrite（多轮指代消解，失败降级）
  → retrieve → rerank → contextBudget → confidenceCheck
  → specialistNode ⇄ toolExecutor（最多 5 轮）
  → orchestration（冲突消解）
  → answerGeneration
  → outputReview（确定性检查 → 模型终审）
  → { output | humanEscalation（建单 + 交接包） }
```

**技术栈**：TypeScript 6 / Node 22 / LangGraph 1.4 / LangChain 1.x / Qdrant / js-tiktoken / zod v4 / Vitest 4 / better-sqlite3。

---

## 1. 总体架构与依赖倒置

### 1.1 依赖注入：所有外部依赖都从 `BuildGraphConfig` 进

**反面模式**：节点里直接 `new ChatOpenAI()`、`import Database`。结果是单测必须打网络、
必须起 Qdrant，测试跑不动，最后「测试」变成「祈祷」。

**做法**：`src/type.ts` 的 `BuildGraphConfig` 是唯一的依赖入口，20+ 个可注入项，
未注入时一律走**安全降级**而不是联网猜测。

```ts
// src/type.ts
export interface BuildGraphConfig {
  checkpointer?: CheckpointerLike;      // 默认 MemorySaver，生产注入 SqliteSaver
  vectorStore?: VectorStoreType;        // 未注入且无 QDRANT_* 环境 → EMPTY_VECTOR_STORE
  reranker?: Reranker | null;           // null = 显式关闭，退化为向量排序
  llms?: Partial<Record<"simple"|"small"|"large", Llm | Llm[]>>;  // 数组 = 降级链
  llmRouter?: Partial<Record<LlmTask, Llm>>;
  maxToolTurns?: number; maxContextTokens?: number; maxChunks?: number;
  confidenceThreshold?: number; sessionTokenBudget?: number;
  prefilter?; inputGuardrails?; actionGuardrails?; reviewer?;
  tools?: AgentTool[]; idempotency?; signalBus?;
  proposalService?; ticketService?; escalationPolicy?; tracer?; clock?;
}
```

**关键细节**：

1. `clock?: () => number` 是全局注入的时间源。**测试 TTL / 过期 / 留存一律用可推进时钟**，
   固定位时钟永远测不到过期分支。
2. `EMPTY_VECTOR_STORE`（`agent.ts:44`）是「没有 Qdrant 也能跑通 FAQ 直答和测试」的安全空实现，
   `search()` 返回 `[]`，不会偷偷联网。
3. `llm/chat.ts` 是**懒加载**的（`await import("./llm/chat")`），避免单测被
   `@langchain/openai` 的 3s 冷启动拖慢。
4. `resolveConfiguredLlm()` 的兜底顺序：`llmRouter[task]` → `llms[tier]` → 任意已注入档位
   → 环境变量建真实模型 → `undefined`。最后一档保证「没配模型时图仍可跑通确定性路径」。

**追问预判**：
- Q：为什么不直接依赖 LangChain 的 `BaseChatModel`？
  A：自己定义 `Llm` 接口（`src/llm/types.ts`）是为了**强制响应带回 token 用量**——
  没有 `promptTokens/completionTokens`，T2.2 的预算和 T6.3 的成本核算无从实现；
  也是为了带上 `tier` 与 `degraded / fallbackFrom / fallbackExhausted` 三个降级字段。
- Q：接口这么薄，流式怎么办？
  A：`stream?` 是可选方法。降级链的流式实现只在**第一个 chunk 产出前**允许换模型，
  一旦开始吐字就不再切换，否则用户会看到两个模型的输出拼接（`llm/degradation.ts:118`）。

### 1.2 LangGraph 图结构

**做法**：`StateGraph(AgentState)` + 16 节点 + 条件边，路由**全部读 `state.route` 字段**，
不在路由函数里写状态。

```ts
// src/agent.ts:964
const workflow = new StateGraph(AgentState)
  .addNode("turnStart", turnStart)
  ...
  .addConditionalEdges("prefilter", (state) => state.route, { direct:"output", escalate:"humanEscalation", pending:"guardrails", specialist:"guardrails" })
  .addConditionalEdges("specialistNode", (state) => routeAfterSpecialist(state, maxToolTurns), { tools:"toolExecutor", orchestrate:"orchestration", escalate:"humanEscalation" })
  .addConditionalEdges("toolExecutor", (state) => routeAfterTools(state, maxToolTurns), { specialist:"specialistNode", review:"outputReview", escalate:"humanEscalation" })
  .addConditionalEdges("outputReview", (state) => routeAfterReview(state, sentimentThreshold), { output:"output", escalate:"humanEscalation" });
```

**关键细节**：LangGraph 的**条件路由函数不能写 state**——它是纯函数，返回值只决定下一条边。
所以「轮次撞上限」「预算超限」这类终止原因必须在**节点内**落盘
（`toolExecutor` 里 `terminationReason: "max_tool_turns"`），路由再读它。

---

## 2. 编排骨架（P1）

### 2.1 T1.1 分诊（Triage）：规则前置 + 小模型 + 保守降级

**反面模式**：把分诊全交给 LLM。实测纯 LLM 分派只有 ~90% 准确率，而「转人工」「投诉」
这类明确指令用规则是 100% 且不花钱。

**做法**（`src/nodes/triage.ts`）：

1. **规则前置**：`humanRequested`（命中「转人工/人工客服/我要投诉」等）直接返回
   `source: "rule"`，零 token。
2. **正则硬规则**：`DEFAULT_HIGH_URGENCY_PATTERNS`（无法登录/服务挂了/重复扣款/生产环境…）
   与 `DEFAULT_REALTIME_PATTERNS`（订单状态/物流/账单金额/余额/库存…）并行扫描。
3. **小模型分类**：`json: true` + `temperature: 0`，输出经 `parseJsonLoose` 兜底
   （兼容 ```json 代码块与前后废话）。
4. **规则与模型合并，规则优先**：
   ```ts
   urgency: isHighUrgency ? "high" : (modelResult.urgency ?? "normal"),
   likelyNeedsHuman: isHighUrgency || Boolean(modelResult.likelyNeedsHuman),
   ```
5. **保守降级**：模型返回非法 JSON 或模型不可用 → `conservativeTriage()`
   返回 `likelyNeedsHuman: true, source: "fallback"`，**绝不猜一个分类继续走**。

**为什么「猜错类别」比「转人工」代价更高**：猜错会把工单派到错误的专家，专家带着错误的
工具清单和 prompt 去检索，产出的是一份看起来很完整但方向全错的答案；而转人工只是慢一点。

**追问预判**：
- Q：规则优先级高于模型，那模型岂不是白调了？
  A：不白调。规则只能覆盖「字面信号明确」的场景（紧急度关键词、明确要求人工），
  类别判定（billing / integration / technical…）和多标签（一个工单跨两类）必须靠模型。
  规则是**硬约束**，模型是**建议**——只有规则没说话的地方才听模型。
- Q：`source` 字段有什么用？
  A：让评测集能分别统计「规则命中率」和「模型准确率」，两者退化方式不同，运维动作也不同。

### 2.2 T1.2 编排循环与轮次上限

**做法**：`specialistNode ⇄ toolExecutor` 构成循环，`maxToolTurns` 默认 5。
三条路由逻辑（`agent.ts:239`）：

```ts
function routeAfterSpecialist(state, maxToolTurns) {
  if (state.route === "escalate") return "escalate";
  if (pendingToolRequests.length > 0 && state.toolTurns < maxToolTurns) return "tools";
  // T3.3 强制取数：分诊说要实时数据但本轮一个工具都没调 → 必须去调
  if (state.triage?.needsRealtimeData && currentTurnToolCalls(state).length === 0) {
    return state.toolTurns < maxToolTurns ? "tools" : "escalate";
  }
  return "orchestrate";
}
```

**关键细节**：终止原因写进 state，不写进路由。
`terminationReason` 取值：`max_tool_turns` / `tool_not_registered` / `tool_boundary_violation`
/ `realtime_tool_required_but_not_requested` / `confirmation_invalid` / `action_guardrail:*`
/ `session_token_budget_exceeded` / `all_models_failed` / `proposal_service_unavailable`
/ `signal_bus_unavailable`。**每一个都对应一条独立的转人工路径**——这是可观测性的地基层。

**追问预判**：
- Q：死循环怎么防？
  A：三重。① `toolTurns >= maxToolTurns` 硬上限；② 每轮 `turnStart` 把 `toolTurns` 归零；
  ③ 专家 prompt 里注入【本轮已调用过的工具】清单，从源头减少重复请求。

### 2.3 T1.3 专家节点与工具边界

**反面模式**：在 prompt 里写「你只能调用 X」。这是**建议**不是**约束**，模型照样能请求 Y。

**做法**（`src/nodes/specialists.ts` + `src/nodes/specialist.ts`）：

1. **注册表**：`SPECIALIST_REGISTRY` 为每个类别声明 `promptPath / toolNames / evalSetPath / priority`。
   例：`billing` 能读账单、提议套餐变更，**不能**改集成配置；`general` 只有 `create_ticket`。
2. **代码级边界**：`enforceToolBoundary(requests, category)` 在**执行前**把越界请求拆到
   `rejected`，**不静默丢弃**——记进 `rejectedToolRequests` 供审计与评测统计「模型越界率」。
3. **并行执行、无状态串扰**：
   ```ts
   return Promise.all(categories.map((c) => runSpecialist(c, input, options)));
   ```
   每个专家只读从 state 派生的只读快照（contextChunks / toolResults 都是入参），
   输出写进各自的 `SpecialistOutput` 对象——**专家之间没有共享可变引用**。
4. **独立提示词版本轨**：`getSpecialistPrompt(category).version` 写进输出，
   不再是「同一模板 + {{category}} 占位」。

**追问预判**：
- Q：为什么不做真正的多智能体（各自子进程 / 各自 LLM 实例）？
  A：引 Diffco 的原话——「架构变成多智能体是**挣来的**，不是选来的」。
  当前瓶颈（召回质量、prompt 质量）在单 Agent 内没到撞墙的程度，拆多智能体只会先付出
  调度、可观测与调试的代价。注册表是**预留的形状**，拆的时候改执行方式即可。

### 2.4 T1.4 编排器（Orchestrator）

**反面模式**：让编排器也有工具。等于把「能在多个专家结论之上再动手」的能力集中到一个
**没有领域边界约束**的节点上，爆炸半径反而比专家更大。

**做法**（`src/nodes/orchestrator.ts`）：

- `export const ORCHESTRATOR_TOOLS: readonly string[] = Object.freeze([]);`——
  工具清单恒为空，这是设计约束不是配置。
- **单专家直通**：`usable.length === 1` 直接返回，不调模型。单专家场景过一遍编排器，
  等于多花一次调用去「拼接」一份本来就完整的答案，还引入一次被改坏的机会。
- **多专家且都 resolved**：按优先级确定性拼接，也不调模型。
- **只有存在 needsOrchestrator 时才请模型**，且传的是 `JSON.stringify(结构化输出)`，
  不是自然语言段落——Diffco 明确拒绝「Agent 用自然语言互相辩论」。
- **冲突消解是确定性的**：按 `priorityOf()` 排序（technical=4 最高，因为服务不可用通常压过账单问题），
  标注被压制的类别与信息缺失项。
- 模型失败 → 回落到确定性拼接，并追加一条降级说明，**绝不阻断回复**。

---

## 3. 检索链路（P2）

### 3.1 T2.1 查询改写

**做法**（`src/nodes/rewrite.ts`）：首轮无历史直接透传，不调模型（省一次调用，
也避免模型把干净的查询改坏）。改写输出做三重防御：去包裹引号 → 空或超 120 字符回退原文 →
异常回退原文。**改写失败必须降级而非报错**：改写的收益是提高召回，失败的最坏情况只是回到原样。

### 3.2 T2.2 Context Token 预算（双约束）

**反面模式**：只有 `topN=5` 的**条数**截断。条数一样但每篇 2000 字时，prompt 会静默膨胀数倍。

**做法**（`src/nodes/budget.ts`）：「条数上限 + token 预算」双约束，预算是**硬上限**。
按 rerank 分数降序装填，三条边界：

1. 至少保留 1 条最高分 chunk（预算极小时也不返回空上下文，否则生成必然是兜底话术）；
2. 单条超预算时**截断而非整条丢弃**（保住最高分那条的信息）；
3. 返回实际 token 数喂给成本核算。

**踩过的坑（追问高频）**：js-tiktoken 对长中文文本是 **O(n²)**。
实测 900 字 ≈ 0.5s、1800 字 ≈ 2s、3600 字 ≈ 8s、7200 字 ≈ 33s，知识 chunk 常超这个量级，
全量精算会把检索链路卡死。

**解法**（`src/tokens.ts`）：混合策略——

- ≤ 256 字符：`tiktoken` 精算；
- \> 256 字符：保守估算，**CJK 1 字 ≈ 1 token**（实际 0.6~1，只会高估不会低估），
  其余 4 字符 ≈ 1 token，预算硬上限不失守；
- 截断用**二分**找最长前缀（`longestPrefixWithin`），O(n log n) 而不是 O(n²)。

**为什么不用字符数估算**：中文场景 `chars/4` 会低估近一倍（1 汉字 ≈ 0.6~1 token，
1 英文词 ≈ 1.3 token），context 预算形同虚设。

### 3.3 T2.3 租户隔离：三层纵深防御

**反面模式**：只在一处过滤。任何单点实现缺陷 = 全量泄露。

**做法**：

1. **检索层**（`src/vectorstore.ts`）：Qdrant payload filter
   ```ts
   { must: [{ key: "metadata.tenantId", match: { value: tenantId } }],
     must_not: [{ key: "metadata.effectiveAt", range: { gt: now } },
                { key: "metadata.expiredAt", range: { lte: now } }] }
   ```
2. **应用层二次过滤**（`search()` 内 `isKnowledgeDocumentActive`）：兼容旧 Qdrant /
   fake store 对 `must_not` 的忽略。
3. **生成侧**（`buildCitations`）：`chunks.filter(c => c.tenantId === tenantId)`，
   引用构造时再筛一次。
4. **输出侧**（`checkOutput` 的 `cross_tenant_leak`）：引用里出现别的租户 → 终审不通过。

配套的 `filterByTenant<T>()` 刻意做成**独立纯函数**——为了让「检索层被绕过/返回脏数据」
这个场景能被单测覆盖：单测直接构造跨租户脏数据喂进来，断言 citations 里没有他租户内容。

**fail-closed**：`retrieve()` 里 `if (!input.tenantId) throw new TenantMissingError()`。
这条不能放宽成「缺省租户」——一旦有缺省值，「忘记传租户」就从报错变成静默跨租户读取。

### 3.4 T2.4 置信度：不用 LLM 自评

**反面模式**：让模型给自己打分。模型倾向于对输出过度自信，且多花一次调用。

**做法**（`src/nodes/confidence.ts`）：用两个**可计算**信号组合：

```
normalizedTop = (topScore - min) / span   // 相对归一化：rerank 分数域不固定，量纲不同
coverage      = |{s : s >= max*0.6}| / N  // 有多少比例的 chunk 分数接近最高分
score         = normalizedTop * 0.7 + coverage * 0.3
lowConfidence = topScore < threshold || score < threshold   // 硬门槛
```

**为什么要有 coverage**：只取最高分会漏掉「一条相关、其余全不相关」的情况——
那种答案往往只有一句上下文支撑，容易过度概括。

**为什么 hard threshold 用绝对值**：候选集只有一条时，相对归一化会把 `topScore=0.2`
误判成 1.0。所以 `topScore < threshold` 是独立的硬门槛。

**ASR 转写置信度用乘法而不是加权平均**（这一段是极好的追问素材）：

```ts
export function adjustForTranscriptConfidence(score, transcriptConfidence, weight = 1) {
  if (tc == null) return score;
  return clamped * (1 - weight + weight * tc);   // 乘法
}
```

加权平均（`(1-w)*score + w*score*tc`）即使 `tc=0` 也只能把 1.0 压到 0.6，**永远够不到 0.35
的低置信阈值**——看起来「影响了」，实际一次都没触发过兜底。语义上乘法才是对的：
**答案的可信度不可能高于「问题被听清的程度」**。

---

## 4. 工具层（P3）

### 4.1 T3.1 工具契约与读写分级

**做法**（`src/tools/contract.ts`）：`AgentTool` 声明 `kind / schema / domains /
requiresConfirmation / idempotent / credential`，并且有**静态契约校验**：

```ts
export function assertToolContract(tool) {
  if (tool.kind === "write") {
    if (!tool.requiresConfirmation) throw new Error(...);  // 否则「未确认就改状态」会悄悄存在
    if (!tool.idempotent)          throw new Error(...);   // MCP 2026-07-28 协议级要求
    if (!tool.credential.write)    throw new Error(...);   // 读写凭证必须分离
  } else if (!tool.credential.read) throw new Error(...);
}
```

`assertToolRegistry()` 在 `buildGraph` 里被调用，**注册即校验，重复名字直接抛错**。

**执行入口唯一化**（`executeTool`）顺序：剥离模型身份参数并校验 schema → 服务端验证确认单及令牌
→ 租约幂等 `begin()` → 真正执行 → 结果提交与审计。任意非空字符串不能充当确认令牌。

### 4.2 T3.2 幂等：键怎么算

```ts
readKey = SHA256(stableStringify([tenantId, principal, threadId, toolName, args, turnIndex]))
writeKey = proposal.idempotencyKey
```

- `stableStringify`：对象键**递归排序**后序列化，避免 `{"a":1,"b":2}` 与 `{"b":2,"a":1}`
  算成两个 key；`undefined` 值剔除。
- 安全相关键使用 Node 内置 SHA-256；写操作复用确认单稳定键，不因重试轮次变化而重复执行。
- `IdempotencyStore.begin<T>(key)` 返回 ticket：`hit`（已执行过，直接返回上次结果）/
  `commit(result)`（执行成功后回填）/ `rollback()`（失败释放占位，允许后续重试）。
- 两个实现：`InMemoryIdempotencyStore`（测试）与 `SqliteIdempotencyStore`（落盘）；均有租约、续租和旧 worker 提交隔离。SQLite 用事务抢占，不是“先查再写”。

**与入口幂等的分工**：T9.2 挡「同一条渠道消息被投递两次」；T3.2 挡「同一次编排内部工具被重发/重试」。
**两层都要有**，因为重试可以发生在入口之后（LLM 超时重试、节点重放）。

**追问预判**：
- Q：`turnIndex` 进幂等键，那跨轮重试同一个工具怎么办？
  A：读工具上一轮的结果不得跨轮复用（T3.3 的判定依据就是 `ToolCallRecord.turnIndex`）；写工具使用确认单稳定键，跨轮重试仍去重。
  订单状态这类实时数据，跨轮复用就是拿旧数据骗人。同轮内的重发（LLM 超时重试）才会命中缓存。

### 4.3 T3.3 强制工具调用（禁止凭记忆作答）

分诊判定 `needsRealtimeData` 后，`routeAfterSpecialist` 检查
`currentTurnToolCalls(state).length === 0`（按 `turnIndex === state.turnCount` 过滤本轮），
一个都没调 → 强制回 `toolExecutor`；若专家压根没请求工具 →
`terminationReason: "realtime_tool_required_but_not_requested"` 转人工。

### 4.4 T3.4 MCP 无状态适配 + MRTR

**做法**（`src/mcp/stateless.ts`）：只锁定**接口形状**，传输由调用方注入
（`StatelessMcpTransport.request`）。

- 首个请求可以直接是真实 `tools/call`，**无 initialize、无 Mcp-Session-Id**，
  每个请求可路由到任意实例。
- MRTR（Model-Response-Transport-Resume）：工具返回 `input_required` + `requestState`，
  客户端收集 `inputResponses` 后**回带 requestState 重发**；状态完全在 requestState 里，
  服务端不持有连接。
- W3C Trace Context 透传：`buildMcpMeta(spanOrTrace)` 生成 `traceparent`，
  `parseTraceparent()` 解析上游 header 实现跨服务串联。

**确认状态桥接**（`src/mcp/confirmation.ts`，T3.4 ↔ T5.3）：写动作的三段确认不能用服务端
反向推送（MCP 2026-07-28 已取消该能力），改为：

1. 触发写动作 → 返回 `input_required`，`requestState = "v1:" + base64url(JSON{proposalId, confirmToken, expiresAt})`；
2. 用户确认后客户端回带 `inputResponses.confirm = "confirm"`；
3. 服务端从 requestState 解出确认状态，走 T5.3 的**确定性 confirm 路径**。

安全说明写进注释：requestState 是服务端签发、客户端原样回带的不透明串，
**语义等同令牌**——与 confirmToken 同等级，必须 TLS，且不得写入日志。

### 4.5 T3.5 Action Signal：不直接改库

**反面模式**：Agent 直接调 CRM 写接口。业务系统不可用时 Agent 侧就失败，
还会出现「Agent 说已退款但 CRM 没收到」的不一致。

**做法**（`src/actions/signal.ts`）：`ActionSignalBus.emit()` **只投递信号，不执行任何写操作**。
三条硬约束：

1. `emit()` 幂等：同 `idempotencyKey` 只产生一条 signal（`sig-<key>`）；
2. `dispatch()` 原子 claim 后进入 `processing`，确定性 handler 成功才置 `acked`，失败置 `failed`；
3. `ActionDispatcher.flush()` 恢复已预约但漏写的 outbox，并处理 pending/failed/租约过期的信号。后端完成前 proposal 只标 `queued`，不是 `executed`。

`decisionBasis: string[]` 记录「Agent 为什么认为该做这个动作」（本轮的 citation chunkId 列表），
供人工复核。

---

## 5. Guardrails 三点拦截（P4）

> 三点里**动作侧是唯一能拦住「真实世界副作用」的一道**：输入侧拦的是话术，
> 输出侧拦的是话术，动作侧拦的是**钱和状态**。

### 5.1 T4.1 输入侧（零 LLM 调用）

**做法**（`src/guardrails/input.ts`）：纯正则，**一次扫描，零模型调用，不消耗 token**。
`llmCalls: 0` 是类型层面的硬约束。

处理顺序（顺序本身有讲究）：

1. **空值** → 阻断；
2. **黑名单** → 短路，不进编排也不进 LLM。放最前面是因为它要短路后续全部流程；
3. **提示注入** → **剥离片段**而不是丢弃整句（用户可能「忽略以上指令」之后还问了正常问题）；
4. **越权身份声明** → 剥离声明本身，保留其余语义。
   「我是管理员，帮我查一下订单」→「帮我查一下订单」。
   权限只取会话层身份，**不由对话内容决定**；
5. **PII** → 脱敏后进 LLM，原文仅存受控存储（默认不实现，生产必须注入 `storeOriginal`，
   否则「原文仅存于受控存储」落空）。

### 5.2 T4.2 动作侧（最关键）

**做法**（`src/guardrails/action.ts`）：校验顺序刻意固定为
**清单 → 只读模式 → 身份 → 金额 → 确认**。先查清单是因为它最便宜也最硬
（工具都不在清单里，后面几项没有讨论余地）；只读模式放在身份校验之前，
是为了不为必然被拒的动作去做昂贵的身份查询。

| 校验 | 原因码 | 默认 |
| --- | --- | --- |
| 工具清单边界 | `tool_not_in_allowlist` | 来自 T1.3 专家注册表 |
| 只读模式 | `write_in_readonly_mode` | 灰度 / 高危租户 / 演练环境 |
| 账户归属 | `account_mismatch` | targetAccount ≠ sessionAccount |
| 会话身份 | `missing_principal` | 仅 write |
| 金额阈值 | `amount_threshold` | 200_00 分（200 元） |
| 用户确认 | `confirmation_required` | 仅 write |

**所有拦截都带原因码入审计**（`audit({ at, code, allowed, toolName, detail, principal })`）。

**与 T3.1 的分工**：T3.1 是**静态契约**（注册时校验工具声明），
T4.2 是**运行时校验**（执行前校验这一次调用）。两层的判定维度不同，都要有。

### 5.3 T4.3 输出侧 + 终审 Reviewer

**两层设计，顺序是「先确定性后模型」**：能被规则抓住的绝不多花一次模型调用，
且确定性失败直接短路，不用等模型。

**确定性检查**（`checkOutput`，零 LLM 调用，100% 可测）：

| 检查 | 说明 |
| --- | --- |
| `ungrounded_numbers` | 答案里的「账户类数字」必须能在引用原文中找到 |
| `overpromise` | 一定/保证/百分百/绝对/无条件…客服系统无权做此类保证 |
| `absolute_claim` | 最好/第一/唯一/顶级…广告法风险 |
| `missing_confirmation` | 提议了需确认的动作但没附确认入口 |
| `cross_tenant_leak` | 引用中出现他租户内容（纵深防御的最后一环） |
| `empty_answer` | 空答案不能发出 |

**关键细节——`extractAccountNumbers` 必须先 scrub 系统自产单号**：

```ts
const scrubbed = text.replace(/\b(?:prop|sig|ticket)-[0-9a-f][0-9a-f-]*/gi, "");
```

`prop-<13位时间戳>-<seq>` / `sig-<hash>` / `ticket-<uuid>` 是本轮生成的确认入口与回执，
其中的时间戳/哈希常含 8 位以上连续数字，不剥离的话**确认话术会被 `ungrounded_numbers` 误杀，
确认流程整个断掉**。

**模型终审**（`Reviewer`）：

- `maxAttempts = 2`，失败即返回 `passed: false` + violations；
- **终审模型不可用时降级放行，但不能静默**——返回 `passed: true` 且带一条
  `model_review_failed` violation，作为可观测标记；
- **不通过时携带草稿转人工，而不是直接丢弃**（`review()` 的返回值保留 draft，
  调用方拿它去建交接包）。

---

## 6. 人机协同（P5）

### 6.1 T5.1 转人工触发条件

**做法**（`src/escalation.ts`）：`evaluateEscalation(signals, config)` 是**纯函数**——
同样输入必然同样输出，可回放、可评测。10 个触发条件：

`user_request` / `repeated_fallback`(≥2) / `negative_sentiment`(强度≥0.8) /
`reviewer_rejected`(≥2) / `triage_likely_needs_human` / `high_urgency` /
`low_confidence_repeat`(≥2) / `budget_exceeded` / `all_models_failed` / `policy_violation`

**情绪判定用规则不用 LLM**（`src/sentiment.ts`）：转人工是安全兜底路径，
不能依赖「模型有空且判得准」——**模型超时/降级时恰恰最需要情绪触发**。
极端负面往往有强烈字面信号，规则更稳、可回放、零延迟。

打分：强负面词表（辱骂/投诉升级/监管曝光，每个 0.5）+ 中负面词表（不满描述，每个 0.22）
+ 强度修饰（连续感叹号 +0.2、反复未解决 +0.1、长段控诉 +0.1、全大写 +0.1）。
同类词重复最多计 2 次，**避免刷屏刷满强度**。

**关键细节（这段是死代码修复，见 §13.1）**：`routeAfterReview` 与 `evaluateEscalation`
**共用同一份阈值常量** `DEFAULT_SENTIMENT_INTENSITY_THRESHOLD`，否则会出现
「判定要升级、路由却直出」的矛盾。

### 6.2 T5.2 交接包（Handoff Package）

**反面模式**：升级只丢一句「用户要转人工」。人工从零开始看整个会话。

**做法**（`buildHandoffPackage`）：带完整 transcript + 结构化账户上下文 + 工具结果 +
**已写好的草稿回复** + 引用 + 检索上下文摘要 + 置信度。
人工是在**编辑**而不是从零开始——Diffco 称大部分时间节省实际来自这里。

**PII 按坐席权限脱敏，但保留结构**：

```ts
transcript.map(e => ({ role: e.role, content: redactForClearance(e.content, clearance), at: e.at }))
```

角色、顺序、时间戳完整保留，只抹内容——这是「脱敏不破坏排障所需结构信息」的落点。
`clearance`: `none`（连数字都抹）/ `masked`（默认，保形脱敏）/ `full`（允许查看 PII）。
策略同时覆盖嵌套账户字段、JSON 工具摘要、引用和原因；密码、确认令牌等秘密字段在所有权限级别下均删除。

**关键细节（死代码修复，见 §13.2）**：终审不通过时，被拦回的草稿**只进交接包，绝不发给用户**：

```ts
const reviewRejected = state.review?.passed === false;
const userFacingAnswer = !reviewRejected && state.finalAnswer && state.finalAnswer !== EMPTY_RETRIEVAL_FALLBACK
  ? `${state.finalAnswer}\n\n我已为你转接人工客服，请稍候。`
  : "当前无法在安全范围内完成回答，我已为你转接人工客服，请稍候。";
```

否则「高风险回复不存在已发出才被拦截的路径」这条验收就被拼接绕过了。

### 6.3 T5.3 propose / confirm / execute 三段分离

> Diffco 称之为「整个系统中最重要的一条设计规则」：**Agent 建议，用户确认，代码执行**。

**代码级保证——不存在「LLM 输出直接触发写操作」的路径**。做法是把三段拆成三个独立方法，
让「跳过 confirm 直接 execute」在类型与运行时两侧都不可达：

```ts
propose(input)  // 只返回 proposal（含 confirmToken），不接触任何执行器
confirm(input)  // 校验令牌绑定与有效期，返回「已确认」状态
execute(proposal, tool, executeFn)  // 重读权威记录、抢占执行租约；已完成只回放结果
```

**注意 `propose()` 的入参里没有执行器**——Agent 侧拿不到任何可执行的东西，
只能拿到一个待确认的 proposal 对象。这是**设计约束，不是约定**。

**确认令牌绑定会话身份**：

```ts
token = HMAC_SHA256(secret, stableStringify({ id, action, params, tenantId, threadId, principal, expiresAt }))
```

`confirm()` 对照存储中的 tenantId/threadId/principal 校验身份，并重新派生令牌后常量时间比对。
用户确认直接走确定性节点，动作参数取已保存的 proposal，不再经过模型。此前的“非空 token 即确认”已被移除。
他人持令牌换个会话来确认，身份或令牌不符即拒绝
（`token_identity_mismatch`）。TTL 默认 15 分钟，过期置 `expired`。

`execute()` 要求写工具、匹配动作和完整参数，并以数据库状态为准。pending 不可执行，
queued/executing/failed 按租约恢复，executed 只回放缓存结果；用户传入的状态不是授权凭据。

`ActionResult.deterministic` 恒为 `true`——供审计断言「执行路径不经过 LLM」。

### 6.4 T5.4 工单生命周期

> 表面上是个状态机，实际是**评测闭环的数据底座**。

**做法**（`src/tickets.ts`）：

- 状态：`open → assigned → pending → resolved → closed`，`ALLOWED_TRANSITIONS` 是显式转移表，
  非法转移抛 `IllegalTicketTransitionError`，状态不允许被写坏。
- **关闭必须记录 `resolution`**（`agent-resolved` / `human-resolved` / `abandoned`）。
  没记 resolution 的关闭会被拒绝——**宁可流程报错，也不要产出无法计算指标的脏数据**。
- **二次来访在「创建」时判定**：同 threadId 下已有 closed 工单 → 新单 `secondVisit = true`。
  这是 resolution rate 分母里「无二次来访」的来源。
- 创建幂等：同 `idempotencyKey` 返回既有单，不产生第二张。
- 评价回流：`rate()` 记录 1-5 星 + 评论 + 类别（T7.2 满意度门槛的数据来源）。

---

## 7. 降级与成本（P6）

### 7.1 T6.1 降级链

**核心约束**：系统在任何单点故障下**仍有响应**——可以答得不够好，不能没有响应。

**做法**（`src/llm/degradation.ts`）：`LlmFallbackChain` 实现 `Llm` 接口，
**本身就是链表里的一个节点**，可以嵌套。

**关键决策：不可重试错误不重试也不降级，直接上抛**：

```ts
if (err instanceof AgentError && !err.retryable) throw err;
```

`TenantMissingError` / `GuardrailBlockedError` 属于**确定性拒绝**，
换模型再试一次没有任何意义，只会掩盖真实原因、放大延迟与成本。
这一条依赖 T0.3 的错误模型里 `retryable` 字段——**降级逻辑只凭它决策，不靠字符串匹配错误信息**。

全链耗尽 → 返回固定兜底话术并置 `fallbackExhausted: true`，
由编排层识别为 `terminationReason: "all_models_failed"` 并进人工队列，
**不把固定话术伪装成模型答案**。

**追问预判**：
- Q：重试为什么 `maxRetries: 0`（chat.ts）？
  A：避免两层重试叠加。ChatOpenAI 客户端的 `maxRetries` 置 0，
  重试统一交给降级链决策——这样「同模型重试几次 → 换下一个模型」是一条可观测、可调的策略，
  而不是散在两个地方。

### 7.2 T6.2 模型分级

```ts
export const DEFAULT_TASK_TIER: Record<LlmTask, ModelTier> = {
  triage: "simple", rewrite: "simple",   // 分派从主 Agent 解耦到专用轻量模型
  specialist: "small", orchestrate: "small", review: "small",
  generate: "large",
};
```

`ModelRouter.resolveTier()` 是**纯函数**——清单要求「模型选择结果可观测且可被评测集回放」，
同样的 ctx 必然得到同样的档位。`resolve(task, ctx)` 返回的降级链是
**该档位 + 更高档位**（simple → small → large），所以降级只会往「更贵但更强」走。

### 7.3 T6.3 预算硬约束

- `maxContextTokens = 1500`（单次 prompt 上下文）
- `sessionTokenBudget = 12_000`（**单会话累计**，跨轮累加）
- `maxToolTurns = 5`、`maxChunks = 5`、`confidenceThreshold = 0.35`

超预算的处理：`budgetNode` 与 `generateNode` 都会置
`terminationReason: "session_token_budget_exceeded"` 并 `route: "escalate"`——
**宁可转人工也不无限烧钱**。

`BudgetUsage` 里专门有 `savedTokens` 字段，累加 T9.3 前置直答省下的 token。

---

## 8. 评测闭环（P7）

> Klarna 教训的直接产物：用 deflection（拦截率）汇报收益，最后翻车。
> 本项目把「主指标必须是 resolution rate」写进了数据结构。

### 8.1 T7.1 评测集与回放：**真跑图**

**反面模式**：JSONL 里手写 expected **和 observed**，回放直接返回 fixture 里的数字。
结果是评测闭环与 Agent 真实行为完全无关——**质量门禁在空转**。

**做法**（`src/eval/replay.ts`）：

```
fixture.script  →  fake LLM 各 stage 响应 + fake 向量库回包
                →  buildGraph(真图)  →  graph.invoke()
                →  observed 全部从图的真实输出计算
```

这样当实现退化（比如检索断了 → `knowledgeHit` 变 false），回放会**真实地变红**。

observed 的计算规则：

| 指标 | 计算 |
| --- | --- |
| `knowledgeHit` | `citations.length > 0` |
| `factuallyCorrect` | `expectContains` 全部命中 finalAnswer |
| `toolCallCorrect` | 本轮 toolCalls 与 expectedTools **集合相等** |
| `humanInvolved` | `escalation.required === true` |
| `deflected` | 未升级 且 非空 且 非 EMPTY_RETRIEVAL_FALLBACK |
| `latencyMs` | 实测 |
| `costUsd` | `budget.totalTokens × 0.000002` |
| `satisfaction` | **`null`**（单轮回放拿不到，不编造） |
| `secondVisit` | 场景标注（单轮回放无法自证） |

**诚实原则**：拿不到的指标输出 `null` 而不是编一个数。这条贯穿整个评测模块。

### 8.2 T7.2 指标：主次分明

```ts
metricNotes: {
  resolutionRate:  "无人工介入且无二次来访；它是质量指标。",
  deflectionRate:  "路由指标，不得单独论证收益；它与 resolutionRate 独立计算。",
}
```

`resolved = !humanInvolved && !secondVisit`——**解决必须包含「没有二次来访」**，
否则「Agent 把人打发走了但用户明天又来」会被算作解决。

**savings 结论拒绝无基线输出**：

```ts
if (!humanBaseline) throw new Error("拒绝输出 savings 结论：缺少人工 baseline");
```

没有人工 baseline 就不许说「省了多少钱」——这正是 Klarna 那类汇报的机制根源。

### 8.3 T7.3 CI 质量门禁

```json
{ "resolutionRateBaseline": 0.5, "satisfactionMinimum": 4,
  "securityTests": { "required": ["tenant-isolation","action-confirmation","guardrails"], "blockOnFailure": true } }
```

三条检查全部通过才放行。**基线的语义是「防退化的下限」而非质量目标**——注释里写得很清楚：
当前 12 条 fixture（含 5 条升级路径与 1 条二次来访）的真实 resolutionRate 是 0.5，
目标值（如 0.75）应该通过扩评测集、提实现逐步逼近，而不是写进门禁让它永远红。

**满意度无数据时不阻断但显式回显**：`ratedCaseCount === 0` → `noData: true`，
`passed: true`。一旦有数据，低于下限必须阻断。

安全测试必须 `SECURITY_TESTS_PASSED=true` 环境变量显式声明才放行门禁——
**不能让一个没跑过的安全测试默认通过**。
CI 通过步骤 `env` 将 `steps.security.outcome == 'success'` 传入评测命令，
同一条验证链也运行核心类型检查、单元测试、SQLite 恢复测试及服务端契约测试。

---

## 9. 可观测与治理（P8）

### 9.1 T8.1 结构化 tracing

**为什么自研 span 收集器而不是只用 Langfuse**：

1. Langfuse 是异步上报，**单测里断言不到**；
2. 「traceId 贯穿全链路并可关联到工单」这类断言需要**进程内可查**的 trace 树；
3. W3C Trace Context 要能透传到 MCP 工具侧，本地得先有这个结构。

**做法**（`src/observability/tracer.ts`）：

- W3C `traceparent: 00-<32hex traceId>-<16hex spanId>-01`，`parseTraceparent()` 解析上游 header；
- 14 个 `SpanStage`，每个图节点由 `withSpan()` 包装，**异常自动记为 error span**；
- 语义属性自动补全：`gen_ai.request.model` / `gen_ai.usage.input_tokens` /
  `gen_ai.usage.total_tokens` / `rag.degraded`（对齐 OTel GenAI 语义约定）；
- ticketId 创建后回写进 span（`span.attributes["ticket.id"]`）；
- `totalTokens(traceId)` 供成本核算。

Langfuse / LangSmith 通过 `getTracingCallbacks()` 注入（`src/observability.ts`），按环境变量开关。

### 9.2 T8.2 PII 与留存

**两个互相拉扯的约束**：审计日志里不能出现明文 PII，但脱敏不能破坏排障所需的结构信息。

**折中：保形脱敏**——保留类型标记、长度与前后缀，只抹中间可识别段。
排障时能看出「这里有个手机号、11 位、138 开头」，但拿不到完整号码。

| 规则 | 保留头 | 保留尾 |
| --- | --- | --- |
| 手机号（11 位 1[3-9]） | 3 | 4 |
| 邮箱 | 2 | 域名全留（排障需要知道是哪个域的账号） |
| 身份证（18 位） | 6 | 4 |
| 银行卡（16-19 位） | 4 | 4 |
| 中文地址 | 2 | 0 |

`AuditLog.append()` **写入前递归脱敏**，避免调用方忘记处理 payload。

**留存**：`RetentionRunner` 按 `audit / session / persistence` 三类目标分别算 cutoff
（180 天 / 365 天 / 365 天），**避免 checkpoint 或幂等记录被错误地套用会话 TTL**。
`SqliteSaver` 实现 `RetentionTarget`（`kind = "session"`），`purge()` 删过期 checkpoint
并手工清理孤儿 writes。

### 9.3 T8.3 知识库生命周期

**做法**：每个 chunk 带 `version / effectiveAt / expiredAt` 元数据，
检索时 Qdrant filter 做时间窗过滤（`must_not: effectiveAt > now, expiredAt <= now`）
+ 应用层二次过滤（§3.3）。

入库侧（`src/vectorstore.ts`）：

- **Markdown 按标题切章节**（语义边界优先于字数），策略自动判断：
  `#` ≥3 且多于 `##` → 按一级标题；`##` ≥ 2 → 按二级标题且**文首引言拼进各节**
  （保留手册标题上下文）；否则整篇作为「全文」。
- 章节过长再按 `chunkSize=500 / chunkOverlap=50` 二次切分，保留
  `section / sectionChunk / sectionChunks` 元数据。
- `INGEST_BATCH_SIZE = 32`，避免请求体过大导致 fetch failed。
- `replace` 默认 true：先写完不可见 generation，再以 revision 校验原子切换发布记录，最后清理观察到的旧版本。
  embedding/写入失败保留旧知识；清理失败时旧向量不再可检索。所有读写程序必须共享持久发布记录。
- `ensureCollectionDimension()`：嵌入模型切换导致维度不一致时自动删 collection 重建
  （FakeEmbeddings 4 维 vs 真实模型 1024 维）。

---

## 10. 渠道与接入层（P9）

### 10.1 T9.1 渠道适配层

**做法**（`src/channels.ts`）：渠道层**只做归一化**，不参与分诊/检索/生成。
企微、微信客服、千牛、网页、电话 ASR 的差异全部吸收在入口，
编排层只接收 `InboundMessage`。

安全边界：`tenantId / principal` 必须由接入层鉴权结果传入（`ChannelAdapterContext`），
**永远不从渠道 payload 读取**。`rawPayload` 只用于排障，`toGraphInput()` 显式丢弃，
不进入 LLM 上下文。

附件路由：`image → multimodal`、`document → knowledge_ingest`、`audio → asr`、
其余 → `reject`（`toGraphInput` 直接抛 `UnsupportedAttachmentError`）。

**ASR 转写置信度取最低而非平均**：用户说了三句话，只要有一句没听清，整通电话的语义就是可疑的。
非 ASR 渠道返回 `null`——用 1.0 兜底是错的，那等于假装文本渠道的转写是完美的。

### 10.2 T9.2 接入层：鉴权 / 幂等 / 限流

> **安全底线**：`tenantId` 必须来自鉴权凭证，绝不从请求体读取。
> 请求体里的 `tenantId` **刻意保留在类型里**，是为了让调用方**看见**它会被丢弃。

**顺序刻意固定为 鉴权 → 幂等 → 限流**：

1. 鉴权先行，否则未认证请求也能消耗租户配额（可被用来打配额耗尽攻击）；
2. 幂等先于限流，否则重试请求会被限流误杀，Webhook 重试语义被破坏。

限流是**租户级隔离舱**：`TenantRateLimiter` 每租户独立计数，
单租户异常流量只能打满自己的配额，不影响其他租户。默认 60 次 / 60 秒。

入口幂等使用 `claim/renew/complete/fail` 生命周期和内容指纹；完成前不标成功，失败和租约过期可重试。
已完成的重复消息回放原结果，处理中返回可重试状态。同线程串行执行，checkpoint 中记录已完成 operationId，
可在入口结果提交失败时恢复原答案，避免多推进一轮。`first()` 仅保留弃用兼容接口，不应用于新接入。

### 10.3 T9.3 前置拦截与直答

**这是整条链路里唯一零模型调用就能完整应答的一层**，也是成本优化性价比最高的抓手。

顺序：**黑名单 → 明确指令（转人工）→ FAQ 直答 → 闲聊兜底 → 放行**。
黑名单第一（不合法输入不该享受任何后续服务），明确指令第二（用户已经说了要什么，
问模型是自作主张）。

**直答命中率可观测**：`Prefilter.metrics()` 输出 `total / hits / hitRate / byType / savedTokens`。
`savedTokens = savedTokensPerHit(2200) + countTokens(faq.answer)`——
直答省下的是「本来要进 prompt 的上下文 + 生成输出」两部分。

### 10.4 T9.4 流式输出：先审后发

**反面模式**：边生成边发。高风险内容会先发到用户面前再被拦回来——
「拦截」在用户眼里根本不存在。

**做法**（`src/index.ts`）：先完整执行图并完成输出 Guardrails / Reviewer，
再把**已通过终审的 finalAnswer** 按 24 字符分块 yield。

代价是首字延迟 = 完整链路耗时，换来的是「高风险回复不存在已发出才被拦截的路径」。
另外，客户端中断发生在 checkpoint 已落盘之后，**不会丢失会话状态**。

`createGraph()` 只接受 `AccessGateway` 签发的带内部标记的 `authContext`。
`authenticated: true` 或 JSON 拼出的同形对象均无效。历史来自 checkpoint，不采信请求里的 system/history。
`streamTokens()` 默认 strict 且生产禁止其他模式；chunked/async 当前收集完整图事件后才重放，不提供首 token 延迟优势。

---

## 11. 地基：状态、错误、持久化（P0）

### 11.1 State 设计：什么必须活在 checkpointer 里

**反面模式**：会话状态存进程内存。多轮会话丢上下文，重启即清零。

**做法**（`src/state.ts`）：`AgentState` 用 LangGraph 的 `StateSchema` + zod v4 定义，
**多轮计数器必须活在 checkpointer 里**：

```
turnCount / consecutiveFallbackTurns / consecutiveLowConfidenceTurns / consecutiveReviewFailures
```

T5.1 的转人工触发条件**全部依赖这些计数**——它们一旦活在进程内存里，重启即清零，
连续两次兜底、连续两轮低置信这些触发条件就永远不生效。

两个细节：

1. **追加式字段用 `ReducedValue`**：`toolCalls` / `degradations` 节点返回单条，
   reducer 负责 append。
2. **ASR 转写置信度分两个字段**：`transcriptConfidence` 是本轮**入参**，
   `asrTranscriptConfidence` 是本轮**生效值**。`turnStart` 把前者固化进后者并清空前者，
   否则上一通电话的低转写置信度会**泄漏到后续文本轮次**里。
3. 情绪每轮由 `turnStart` 对 `query` 重新打分，因此**天然不跨轮残留**，无需手工清空。

### 11.2 T0.3 领域错误模型

```ts
class AgentError extends Error {
  readonly retryable: boolean;   // 降级链仅凭此字段决策
  readonly stage: string;        // triage / retrieve / generate / review ...
  readonly traceId?: string;
}
```

六个子类：`TenantMissingError`(×) / `GuardrailBlockedError`(×，带 reasonCode) /
`ToolExecutionError`(√) / `LlmTimeoutError`(√) / `LlmConfigError`(×) /
`BudgetExceededError`(×) / `EscalationRequiredError`(×)。

`toAgentError(err)` 把任意未知错误归一为 `AgentError`，**保住 retryable 决策能力**。

### 11.3 T0.4 SQLite Checkpointer

**为什么自己实现**：`@langchain/langgraph` 只内置 `MemorySaver`（进程内、重启即丢），
而 `better-sqlite3` 已在依赖里。

**做法**（`src/sqlite-saver.ts`）：继承 `BaseCheckpointSaver`，序列化走基类默认
`JsonPlusSerializer`，本类只负责存储与索引。WAL 模式，两张表：

```sql
checkpoints(thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint BLOB, metadata BLOB, created_at)
writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
```

**踩过的坑（追问高频）**：LangGraph 的 checkpoint 契约里，
**`putWrites` 的入参 `PendingWrite` 是 `[channel, value]` 二元组，
而 `getTuple` 出参的 `CheckpointPendingWrite` 是 `[taskId, channel, value]` 三元组**——
两者形状不同，不能互相套用。

其他细节：
- 原型污染守卫 `POLLUTION_KEYS = {__proto__, constructor, prototype}`（对齐 MemorySaver）；
- 老库迁移补 `created_at` 列时，**存量记录从迁移时刻起算 TTL**（填 0 会导致升级后
  第一次清理就把全部存量 checkpoint 删掉）。

### 11.4 测试基建

```ts
projects: [
  { name: "unit",        include: ["src/__tests__/**/*.test.ts"], exclude: ["src/__tests__/integration/**"] },
  { name: "integration", include: ["src/__tests__/integration/**/*.test.ts"], passWithNoTests: true },
]
```

- **unit 全 fake，不碰网络 / .env / 本地 Qdrant，CI 必跑**；
- integration 承载 SQLite checkpoint、留存及恢复用例，依赖 better-sqlite3 原生模块，
  **ABI 与 Node 版本绑定**。旧 checkpoint/留存用例保留可用性守卫；新增架构恢复用例直接加载 SQLite，
  模块不可用即失败，不能把持久化验证静默跳过；
- **Vitest 4 的嵌套 project 不继承顶层 `testTimeout`**，必须在每个 project 的 test 块里重申，
  否则冷启动重导入用例（smoke/t8 会拉起 langchain 全家桶，约 6s）以默认 5s 假失败。

---

## 12. 多轮追问剧本（重点）

以下按「面试官最可能从哪个点切入」组织，每条给出**三层递进**的答案骨架。

### A. 安全类（最高频）

**A1. 「你怎么保证模型不会乱改数据？」**

第一层（给结论）：三层，且每一层都是代码级而非提示词级。
① 工具契约静态校验（write 工具必须 `requiresConfirmation` + `idempotent`）；
② 动作侧 Guardrails 六项运行时校验；
③ `executeTool` 里由服务端 verifier 校验已确认 proposal，非空 `confirmToken` 本身不构成授权。

第二层（给机制）：propose/confirm/execute 三段分离。
`propose()` 的**入参里没有执行器**，Agent 侧拿不到任何可执行的东西；
`execute()` 重读权威 proposal 并校验状态、动作和参数，抢占执行租约。
令牌使用 HMAC-SHA256 绑定动作、参数、租户、会话、主体和有效期，客户端修改 proposal 状态不会获得执行权。

第三层（给边界）：写操作先预约为 `queued`，再投递 ActionSignal。
`ActionDispatcher` 恢复漏写 outbox 和过期租约，确定性 handler 成功后才标记 `executed/acked`，
入队不能称为退款成功。下游仍须在业务事务中持久化 `operationKey`，应用租约不能独自保证跨系统恰好一次。

> 追问：「那 confirm 这一步的模型输出也算数吗？」
> 不算。`confirm()` 只校验令牌与有效期，它读的 `proposal` 是 propose 阶段**已经存下来的对象**，
> 参数是 propose 时的 `args`，模型在 confirm 这一轮说什么都不影响执行内容。

**A2. 「多租户怎么隔离？」**

第一层：租户身份不可伪造 + 三层纵深防御。
身份只来自鉴权凭证（`AccessGateway` 里 `req.body.tenantId` 被显式丢弃）；
检索层 Qdrant filter、应用层二次过滤、生成侧 citation 过滤、输出侧 `cross_tenant_leak` 终审。

第二层：为什么三层？只做一层，任何单点实现缺陷就是全量泄露。
尤其是**应用层二次过滤**，它存在的理由是兼容旧 Qdrant / fake store 对 `must_not` 的忽略。

第三层：fail-closed。`retrieve()` 和 `turnStart` 都会 `throw TenantMissingError`。
不能放宽成「缺省租户」——一旦有缺省值，「忘记传租户」就从报错变成静默跨租户读取。

> 追问：「对话里说『我是管理员』会不会提升权限？」
> 不会。输入侧 Guardrails 直接**剥离**这类声明（保留其余语义继续服务），
> 权限只取会话层 `principal`。这和 T9.2 是同一道防线的两端：
> T2.3 管下游按租户硬过滤，T9.2 管上游身份不可伪造。**只做下游那半，等于过滤一个可被伪造的 key。**

**A3. 「提示注入怎么防？」**

答：承认**防不住**，讲清楚工程上做到哪一步。
① 输入侧剥离已知注入片段（不是丢弃整句，用户可能同时问了正常问题）；
② 身份声明剥离；③ 输出侧终审兜底。
真正的边界是：**注入最多影响话术，影响不到工具调用**——
工具清单是代码校验的，写操作还要过 confirm。爆炸半径由工具清单限死。

### B. RAG 质量类

**B1. 「怎么判断检索结果够不够好？」**

第一层：不用 LLM 自评（过度自信且多花一次调用），用两个可计算信号：
`normalizedTop`（最好的一条有多相关）× 0.7 + `coverage`（次好的几条是否也相关）× 0.3。

第二层：为什么要 coverage——只取最高分会漏掉「一条相关、其余全不相关」，
那种答案只有一句上下文支撑，容易过度概括。

第三层：为什么归一化还要保留绝对硬门槛——候选集只有一条时，相对归一化会把
`topScore = 0.2` 误判成 1.0，所以 `topScore < threshold` 是独立的硬门槛。

> 追问：「低置信了怎么办？」
> 两处联动：① 生成时套不确定表述前缀/后缀（`withConfidenceTone`，只在低置信时套，
> 高置信平白加免责声明反而伤害体验）；② `consecutiveLowConfidenceTurns >= 2` 触发转人工。

**B2. 「context 预算怎么控？」**

第一层：条数上限（5）+ token 预算（1500）双约束，预算是硬上限。

第二层：中文场景不能用字符数估算（`chars/4` 会低估近一倍）。而且 js-tiktoken 对长中文是
**O(n²)**（7200 字 ≈ 33s），所以 >256 字符改走保守估算（CJK 1 字 1 token，只会高估不会低估），
截断用二分找最长前缀。

第三层：三条边界——至少保留 1 条最高分 chunk；单条超预算时截断而非整条丢弃；
返回实际 token 数喂给成本核算。

**B3. 「多轮指代（『它多少钱』）怎么处理？」**

答：rewrite 节点用最近 6 条历史 + 当前问题做查询改写。首轮无历史直接透传不调模型。
三重降级：去包裹引号、空或超 120 字符回退原文、异常回退原文。
**改写失败必须降级而非报错**——收益是提高召回，失败的最坏情况只是回到原样。

> 追问：「历史一直涨怎么办？」
> `truncateHistory(maxMessages = 20)`，系统消息永远保留，其余按「最早的先丢」。
> 另外 triage / rewrite / generate 三个节点取历史时都只取最近 6 条。

### C. 可靠性类

**C1. 「模型挂了怎么办？」**

第一层：降级链，同档位内的候选 + 更高档位依次尝试。全链耗尽返回固定兜底话术并置
`fallbackExhausted`，编排层识别为 `all_models_failed` 进人工队列，**不把固定话术伪装成模型答案**。

第二层：**不可重试错误不重试也不降级**（`TenantMissingError` / `GuardrailBlockedError`）。
换模型再试一次没有意义，只会掩盖真实原因、放大延迟与成本。这依赖错误模型的 `retryable` 字段。

第三层：降级不是只有模型。rerank 挂了退化为向量排序；向量库挂了返回空 + 降级标记走兜底；
终审模型挂了降级放行但打 `model_review_failed` 标记；业务系统挂了 signal 堆积可重放。
**核心约束是「任何单点故障下仍有响应」**。

**C2. 「工具重复调用 / 重复退款怎么办？」**

答：两层幂等。入口幂等（T9.2）用 SQLite 租约和请求指纹挡渠道重复投递，
完成则重放结果，失败或租约过期可恢复；同一线程还要串行执行。
读工具键使用 `SHA256(stableStringify([tenantId, principal, threadId, toolName, args, turnIndex]))`，
写工具使用确认单的稳定幂等键；`stableStringify` 递归排序对象键。

> 追问：「为什么 turnIndex 进幂等键？」
> 刻意设计——**上一轮的工具结果不得跨轮复用**。订单状态这类实时数据，跨轮复用就是拿旧数据骗人。
> 读工具只有同轮内的重发才会命中缓存；写工具不能因跨轮重试而重复产生副作用。

**C3. 「工单状态会不会被写坏？」**

答：显式转移表 `ALLOWED_TRANSITIONS`，非法转移抛异常。
关闭**必须**记录 resolution，没记就拒绝关闭——宁可流程报错，也不要产出无法计算指标的脏数据。

### D. 架构决策类

**D1. 「为什么用 LangGraph？」**

答：三个具体理由，不是「因为流行」。
① **有环图**：specialist ⇄ tools 的循环是刚需，纯 DAG 编排框架表达不了；
② **checkpointer 抽象**：会话状态持久化是 P0 需求，`BaseCheckpointSaver` 让我能自己塞一个 SQLite 实现；
③ **StateSchema + reducer**：追加式字段（toolCalls / degradations）用 `ReducedValue` 声明式处理，
不用手写 merge。

代价也要说：条件路由函数不能写 state，所以终止原因必须在节点内落盘——这是被它咬过一次才学到的。

**D2. 「为什么不做多智能体？」**

答：引 Diffco 原话「架构变成多智能体是**挣来的**，不是选来的」。
当前瓶颈（召回质量、prompt 质量）在单 Agent 内没到撞墙的程度，
拆多智能体只会先付出调度、可观测与调试的代价。
注册表是**预留的形状**，专家之间已经是「只读共享快照 + 返回独立结构化对象」的
无状态形态，将来改执行方式（真并行子进程）不用改数据流。

**D3. 「专家之间怎么通信？」**

答：**结构化对象，不是自然语言段落**。Diffco 明确拒绝「Agent 用自然语言互相辩论」——
演示里好玩，生产中不稳定。编排器拿到的就是 `JSON.stringify(SpecialistOutput[])`，
冲突消解也是确定性的（按 priority 排序 + 标注被压制类别）。

**D4. 「编排器为什么没有工具？」**

答：给编排器工具，等于把「能在多个专家结论之上再动手」的能力集中到一个
**没有领域边界约束**的节点上，爆炸半径反而比专家更大。`ORCHESTRATOR_TOOLS` 用
`Object.freeze([])` 冻结——这是设计约束不是配置。

**D5. 「为什么情绪判定用规则不用 LLM？」**

答：转人工是**安全兜底路径**，不能依赖「模型有空且判得准」——
**模型超时/降级时恰恰最需要情绪触发**。极端负面往往有强烈字面信号，
规则更稳、可回放、可单测、零延迟。

### E. 评测与指标类（最有区分度）

**E1. 「你怎么证明这个系统有用？」**

第一层：**主指标是 resolution rate，不是 deflection rate**。
`resolved = 无人工介入 && 无二次来访`。只报 deflection 就是 Klarna 那类翻车的机制根源——
「拦截了 70% 工单」但用户问题没解决，他们第二天又来了。

第二层：数据前提是工单关闭时**必须**记录 resolution 与 secondVisit。
所以 T5.4 表面是状态机，实际是评测闭环的数据底座——**没有这两个字段，主指标根本算不出来**。

第三层：**没有人工 baseline 就不输出 savings 结论**（代码里直接 throw）。
指标拿不到时输出 `null` 而不是编一个数（满意度在单轮回放里就是 `null`）。

> 追问：「那你现在的 resolution rate 是多少？门禁为什么是 0.5 这么低？」
> 当前 12 条 fixture 集（含 5 条升级路径 + 1 条二次来访）的真实值是 0.5。
> **基线的语义是「防退化的下限」而非质量目标**——把 0.75 写进门禁只会让它永远红，
> 正确做法是扩评测集、提实现逐步逼近。这是我刻意的选择。

**E2. 「评测怎么保证不是自欺欺人？」**

答：回放时**真跑图**。fixture 只决定 fake LLM 各 stage 的响应和 fake 向量库的回包，
observed 全部从 `graph.invoke()` 的真实输出计算。这样实现退化时回放会**真实地变红**。
（这一条本身就是修掉的一个 bug，见 §13.3。）

> 追问：「fake LLM 跑出来的延迟和成本有意义吗？」
> 延迟是真实执行耗时（其中包含真实图调度），有意义但**不等于生产延迟**——
> 生产里 LLM 调用是主要耗时。
> 成本是 `totalTokens × 约定单价`，token 计数是真实的（fake LLM 用同一套 `countTokens`），
> 单价是常数。所以它衡量的是**相对成本随实现的漂移**，不是绝对金额。这一点我不会含糊。

### F. 工程类

**F1. 「单测怎么做到不打网络？」**

答：`BuildGraphConfig` 全量注入 + fake 三件套（`createFakeLlm` 支持按 stage 分派、
`FakeBackend` 记录所有副作用调用、`EMPTY_VECTOR_STORE`）。
`llm/chat.ts` 懒加载，避免单测被 `@langchain/openai` 的冷启动拖慢。
双 project 隔离 unit（全 fake，CI 必跑）与 integration（需要原生模块）。
新增恢复用例没有跳过守卫，CI 还运行 HTTP 契约与安全专项，再将真实安全测试结果传入质量门禁。

**F2. 「流式为什么不是真的流式？」**

答：先审后发。实时流式意味着高风险内容会先发到用户面前再被拦回来，
「拦截」在用户眼里根本不存在。代价是首字延迟 = 完整链路耗时。
这是**明确权衡后的选择**，不是没做。

> 追问：「那用户体验怎么办？」
> 承认这是短板。缓解手段是 T9.3 前置直答（命中率可观测）让高频问题根本不进模型链路；
> 真要低延迟，可选路径是「分块终审」（每 N 个 chunk 审一次），
> 但那会引入「已发出才被拦」的窗口，需要按内容风险分级——这是下一步的事。

---

## 13. 六个「发现并修掉死代码」的真故事

> 这一节是面试里的**加分项**：讲「我是怎么发现某个功能其实是死的」比讲「我实现了什么」更有说服力。
> 每个故事都是「功能写了、测试绿了、但生产上从来没生效过」。

### 13.1 情绪触发转人工是死代码

`evaluateEscalation` 支持 `negative_sentiment` 分支，但
**全链路无人计算 sentiment**——`state.sentiment` 永远是默认 `neutral`，
路由也不看 sentiment。结果「极度负面」永远走不到 humanEscalation。

修法：① `turnStart` 每轮对 query 打分；② `routeAfterReview` 增加情绪分支；
③ **两处共用同一常量 `DEFAULT_SENTIMENT_INTENSITY_THRESHOLD`**，
否则会出现「判定要升级、路由却直出」的矛盾。

> 验证教训：第一版端到端测试的输入含「我要投诉」，被 prefilter 的
> `isHumanRequest` 提前拦截了。做 mutation 验证（临时禁用情绪路由）后测试**仍然绿**——
> 说明测试根本没覆盖到修复点。换成命中目标路径但不撞前置规则的输入后才真的变红。

### 13.2 终审不通过的草稿会泄露给用户

`escalateNode` 原本把 `state.finalAnswer` 拼进用户话术。
但终审不通过时 `finalAnswer` 就是**被拦回的那份草稿**——
「高风险回复不存在已发出才被拦截的路径」这条验收被这条拼接整个绕过。

修法：`reviewRejected` 分支发纯兜底话术，草稿只进交接包。
（`state.review` 在 `turnStart` 每轮重置为 null，读到的必是本轮判定，无跨轮残留。）

### 13.3 评测回放在空转

原实现 `return { ...fixture.replay, seed, replayToken }`——**expected 和 observed 都是手写数字**，
评测闭环与 Agent 真实行为完全无关。

修法：改为真跑图（§8.1）。

### 13.4 ASR 置信度用加权平均，一次都没触发过

`score×(1-w) + score×tc×w` 即使 `tc=0` 也只能把 1.0 压到 0.6，
**永远够不到 0.35 的低置信阈值**。看起来「影响了」，实际一次都没触发过兜底。
改成乘法（§3.4）。

### 13.5 系统自产单号被 grounding 规则误杀

`extractAccountNumbers` 的 `\d{8,}` 账户规则会命中
`prop-<13位时间戳>-<seq>` 里的连续数字，导致**确认话术被 `ungrounded_numbers` 判不通过，
确认流程整个断掉**。修法：先 scrub `prop-/sig-/ticket-` 前缀。

> 这个故事还有一层：最初没暴露，是因为一个「违规草稿泄露」bug 恰好带出了确认单号，
> 把问题掩盖了；把泄露修掉（§13.2）之后测试才炸。

### 13.6 状态机缺一条转移边，一种解决方式永远走不到

`close()` 对未 resolved 的单会先补 resolved 再 closed，但转移表 `open → resolved` 不合法，
于是直接抛异常——`agent-resolved` 这类解决方式根本走不到，resolutionRate 少一块分子。
旧用例只测「已 resolved 直关」的路径，暴露不了。

---

## 14. 已知短板与下一步

诚实列出，面试被问到「有什么不足」时直接用，也避免被追问时前后矛盾。

| 短板 | 现状 | 下一步 |
| --- | --- | --- |
| 流式不是真流式 | 先审后发，首字延迟 = 全链路 | 按内容风险分级的「分块终审」 |
| 评测集只有 12 条 | resolutionRate 基线 0.5 | 扩到 100+ 条，覆盖各专家类别 |
| 满意度无生产数据 | 单轮回放恒为 `null` | 接工单评价回流（T5.4 `rate()` 已留好接口） |
| 多专家是串行合并 | 同一进程内 `Promise.all`，非真并行 | 撞墙后再拆，注册表已预留形状 |
| 持久化仍为单机 SQLite | server 已配置化，支持同机多进程租约恢复 | 跨主机共享事务存储、分布式限流和集中留存作业 |
| 知识已支持分阶段发布 | generation + 原子发布记录 + 时间窗/授权过滤 | 审核工作台、灰度、变更 diff 与残留向量清理 |
| 专家提示词未做 A/B | 只有独立版本轨 | 用 T7.1 评测集跑分对比版本 |
| 无真实 trace 后端接入 | 自研 span 在进程内 | `onSpanEnd` 接 OTel exporter |

---

## 附：面试速查表（按文件定位）

| 面试官问 | 直接翻 |
| --- | --- |
| 主链路怎么走 | `src/agent.ts` 的 `buildGraph`（964 行起的图定义） |
| 怎么防越权 | `src/nodes/specialists.ts` `enforceToolBoundary` |
| 怎么写操作确认 | `src/actions/proposal.ts` 三段分离 |
| 怎么隔离租户 | `src/vectorstore.ts` `knowledgeFilter` + `src/nodes/generate.ts` `buildCitations` |
| 怎么算置信度 | `src/nodes/confidence.ts` `computeConfidence` |
| 怎么控成本 | `src/nodes/budget.ts` + `src/prefilter.ts` `metrics()` |
| 怎么降级 | `src/llm/degradation.ts` `LlmFallbackChain` |
| 怎么评测 | `src/eval/replay.ts` `runFixtureThroughGraph` |
| 怎么持久化 | `src/sqlite-saver.ts` `SqliteSaver` |
| 怎么防重复退款 | `src/tools/contract.ts` `toolIdempotencyKey` + `src/tools/idempotency.ts` |
