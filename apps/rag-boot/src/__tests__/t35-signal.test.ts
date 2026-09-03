// T3.5 CRM / 业务系统 action-trigger 集成
//
// 依据 Swiggy：Agent 与 CRM 之间不是直接改库，而是结构化的 action-trigger 集成——
// Agent 产生决策后以 action signal 形式通知 CRM，由 CRM 侧执行。
//
// 清单 459-464 的四条验收，逐条对应下面的用例。
import { MemorySaver } from "@langchain/langgraph";
import Database from "better-sqlite3";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import {
  ActionSignalBus,
  InMemoryActionSignalStore,
  SqliteActionSignalStore,
} from "../actions/signal";
import { ProposalService } from "../actions/proposal";
import { ActionGuardrails } from "../guardrails/action";
import { createRefundTool, FakeBackend } from "../tools/business";

const vectorStore = {
  search: async () => [],
  addDocuments: async () => 0,
  ingestFile: async () => 0,
  deleteByDocumentId: async () => {},
};

// better-sqlite3 是原生模块，ABI 与 node 版本绑定。与 entry-idempotency.test.ts
// 保持同一套约定：装不上就跳过落盘用例，不因此让单测套件变红。
const sqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

/** 每轮都请求退款工具的 fake 模型：第一轮产出 proposal，第二轮用于确认 */
function writeLlm() {
  return createFakeLlm({
    byStage: {
      triage: JSON.stringify({
        categories: ["order"],
        urgency: "normal",
        likelyNeedsHuman: false,
        needsRealtimeData: false,
      }),
      specialist: JSON.stringify({
        status: "needsOrchestrator",
        partialAnswer: "可以申请退款",
        toolRequests: [
          { name: "propose_refund", args: { orderId: "o-1", amountCents: 10, tenantId: "t" } },
        ],
      }),
      generate: "我可以帮你申请退款",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });
}

function emitInput(overrides: Partial<Parameters<ActionSignalBus["emit"]>[0]> = {}) {
  return {
    type: "propose_refund",
    tenantId: "t",
    threadId: "th",
    principal: "p",
    payload: { orderId: "o-1", amountCents: 10 },
    idempotencyKey: "th:propose_refund:1",
    decisionBasis: ["chunk-1", "chunk-2"],
    ...overrides,
  };
}

describe("action signal 集成", () => {
  it("Agent 决策产出 ActionSignal 而非直接调用 CRM 写接口", async () => {
    const backend = new FakeBackend();
    let handlerCalls = 0;
    const bus = new ActionSignalBus({
      handler: async () => {
        handlerCalls += 1;
        return { refundId: "rf-1" };
      },
    });

    const signal = await bus.emit(emitInput());

    // emit 只投递信号：handler 一次都没跑，CRM 后端完全没被碰到
    expect(signal.status).toBe("pending");
    expect(signal.attempts).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(backend.refunds).toHaveLength(0);

    // 投递是独立动作，由确定性后端执行，不经过 LLM
    const result = await bus.dispatch(signal.id);
    expect(result.ok).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it("主图确认后写动作只投递信号，不直接调用 CRM 后端", async () => {
    const backend = new FakeBackend();
    const refundTool = createRefundTool(backend);
    const proposalService = new ProposalService({ secret: "test" });
    const bus = new ActionSignalBus();
    const model = writeLlm();
    const graph = await buildGraph({
      checkpointer: new MemorySaver(),
      vectorStore,
      reranker: null,
      llms: { simple: model, small: model, large: model },
      tools: [refundTool],
      proposalService,
      signalBus: bus,
      actionGuardrails: new ActionGuardrails(),
    });
    const config = { configurable: { thread_id: "signal-flow" } };

    // 第一轮：Agent 只能产出 proposal
    const first = await graph.invoke(
      { query: "请退款", tenantId: "t", principal: "p", threadId: "signal-flow", messages: [] },
      config,
    );
    expect(first.actionProposals).toHaveLength(1);
    expect(first.actionProposals[0].status).toBe("pending");
    expect(await bus.list()).toHaveLength(0);

    // 第二轮：用户确认（令牌 + proposalId 回传）
    const proposal = first.actionProposals[0];
    const second = await graph.invoke(
      {
        query: "确认",
        tenantId: "t",
        principal: "p",
        threadId: "signal-flow",
        messages: [],
        confirmationProposalId: proposal.id,
        confirmationToken: proposal.confirmToken,
      },
      config,
    );

    const signals = await bus.list();
    expect(signals).toHaveLength(1);
    expect(signals[0].idempotencyKey).toBe(proposal.idempotencyKey);
    expect(second.actionProposals[0].status).toBe("executed");
    // 解耦的关键断言：图执行完，CRM 后端的退款表里一条都没有
    expect(backend.refunds).toHaveLength(0);
    expect(backend.calls.filter((call) => call.method === "refund")).toHaveLength(0);
  });

  it("ActionSignal 携带幂等键、会话身份、决策依据", async () => {
    const bus = new ActionSignalBus({ clock: () => 1000 });
    const signal = await bus.emit(emitInput());

    expect(signal.idempotencyKey).toBe("th:propose_refund:1");
    expect(signal.principal).toBe("p");
    expect(signal.threadId).toBe("th");
    expect(signal.tenantId).toBe("t");
    expect(signal.decisionBasis).toEqual(["chunk-1", "chunk-2"]);

    // 幂等：同 key 重复 emit 返回同一条信号，不产生第二条
    const again = await bus.emit(emitInput({ payload: { orderId: "o-2" } }));
    expect(again.id).toBe(signal.id);
    expect(await bus.list()).toHaveLength(1);

    // 不同 key 是另一条信号
    await bus.emit(emitInput({ idempotencyKey: "th:propose_refund:2" }));
    expect(await bus.list()).toHaveLength(2);
  });

  it("下游执行失败时回写会话状态并可重放，重放不重复已成功的", async () => {
    let attempts = 0;
    const bus = new ActionSignalBus({
      handler: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("CRM 502");
        return { refundId: "rf-1" };
      },
    });
    const signal = await bus.emit(emitInput());

    const failed = await bus.dispatch(signal.id);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("CRM 502");

    // 失败回写：状态、错误、重试次数都落在信号上
    const stored = (await bus.list())[0];
    expect(stored.status).toBe("failed");
    expect(stored.lastError).toContain("CRM 502");
    expect(stored.attempts).toBe(1);

    // 业务系统恢复后重放
    const replayed = await bus.replayFailed();
    expect(replayed.map((result) => result.ok)).toEqual([true]);
    expect((await bus.list())[0].status).toBe("acked");
    expect(attempts).toBe(2);

    // 已 acked 的信号重投是空操作，不会在 CRM 侧产生第二次副作用
    const repeated = await bus.dispatch(signal.id);
    expect(repeated.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(await bus.replayFailed()).toHaveLength(0);
  });

  it("signal 与 execute 结果分别落审计日志", async () => {
    const entries: Array<{ kind: string; data: any; at: number }> = [];
    const bus = new ActionSignalBus({
      clock: () => 1000,
      onAudit: (entry) => entries.push(entry),
      handler: async () => ({ refundId: "rf-1" }),
    });

    const signal = await bus.emit(emitInput());
    await bus.dispatch(signal.id);

    expect(entries.map((entry) => entry.kind)).toEqual(["signal", "result"]);
    expect(entries[0].data.id).toBe(signal.id);
    expect(entries[0].data.status).toBe("pending");
    expect(entries[1].data.signalId).toBe(signal.id);
    expect(entries[1].data.response).toEqual({ refundId: "rf-1" });
    expect(entries.every((entry) => entry.at === 1000)).toBe(true);

    // 失败的执行也要落 result 审计，否则排障时看不到下游故障
    const failing = new ActionSignalBus({
      onAudit: (entry) => entries.push(entry),
      handler: async () => {
        throw new Error("downstream down");
      },
    });
    const other = await failing.emit(emitInput({ idempotencyKey: "th:propose_refund:9" }));
    await failing.dispatch(other.id);
    const last = entries[entries.length - 1];
    expect(last.kind).toBe("result");
    expect(last.data.ok).toBe(false);
    expect(last.data.error).toContain("downstream down");
  });

  it("业务系统不可用时信号堆积，换实例仍可补投（不丢单）", async () => {
    const store = new InMemoryActionSignalStore();
    let available = false;
    const handler = async () => {
      if (!available) throw new Error("CRM unavailable");
      return { refundId: "rf-1" };
    };

    // 第一个实例：业务系统不可用，信号堆积而不是丢失
    const first = new ActionSignalBus({ store, handler });
    const signal = await first.emit(emitInput());
    await first.dispatch(signal.id);
    expect((await first.list())[0].status).toBe("failed");

    // 换一个实例（模拟进程重启），信号仍在，业务系统恢复后补投
    available = true;
    const second = new ActionSignalBus({ store, handler });
    const pending = await second.list("failed");
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe(signal.idempotencyKey);

    const replayed = await second.replayFailed();
    expect(replayed.map((result) => result.ok)).toEqual([true]);
    expect((await second.list())[0].status).toBe("acked");
  });

  it("signal 落盘后可跨实例堆积与重放", async () => {
    if (!sqliteAvailable) {
      expect(true).toBe(true);
      return;
    }
    const store = new SqliteActionSignalStore(":memory:");
    let available = false;
    const handler = async () => {
      if (!available) throw new Error("CRM unavailable");
      return { refundId: "rf-1" };
    };

    const first = new ActionSignalBus({ store, handler });
    const signal = await first.emit(emitInput());
    await first.dispatch(signal.id);
    expect((await first.list())[0].status).toBe("failed");

    available = true;
    const second = new ActionSignalBus({ store, handler });
    expect(await second.list("failed")).toHaveLength(1);
    expect((await second.replayFailed()).map((result) => result.ok)).toEqual([true]);
    expect((await second.list())[0].status).toBe("acked");
    store.close();
  });

  it("信号存储支持按状态筛选待补投的堆积量", async () => {
    const store = new InMemoryActionSignalStore();
    const bus = new ActionSignalBus({ store });
    await bus.emit(emitInput({ idempotencyKey: "k-a" }));
    await bus.emit(emitInput({ idempotencyKey: "k-b" }));

    expect(await bus.list("pending")).toHaveLength(2);
    expect(await bus.list("failed")).toHaveLength(0);
    expect(await store.findByIdempotencyKey("k-a")).toMatchObject({ idempotencyKey: "k-a" });
  });
});
