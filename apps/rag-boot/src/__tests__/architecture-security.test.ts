import { describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AccessGateway, EntryIdempotencyStore, TenantRateLimiter, TokenAuthenticator, runAdmitted } from "../access";
import { createGraph } from "../index";
import { buildGraph } from "../agent";
import { createFakeLlm } from "../llm/fake";
import { ProposalService } from "../actions/proposal";
import { ActionSignalBus, InMemoryActionSignalStore } from "../actions/signal";
import { ActionDispatcher } from "../actions/dispatcher";
import { ActionGuardrails } from "../guardrails/action";
import { createOrderStatusTool, createRefundTool, FakeBackend } from "../tools/business";
import { executeTool } from "../tools/contract";
import { InMemoryIdempotencyStore } from "../tools/idempotency";
import type { RagBotInput } from "../type";
import type { StreamEvent } from "../stream-review";

function gateway(idempotency = new EntryIdempotencyStore()) {
  return new AccessGateway({
    authenticator: new TokenAuthenticator({
      a: { tenantId: "a", principal: "alice" },
      b: { tenantId: "b", principal: "bob" },
      other: { tenantId: "a", principal: "other" },
    }),
    idempotency, limiter: new TenantRateLimiter(),
  });
}

const request = (messageId = "message", threadId = "thread") => ({
  credential: { token: "a" }, messageId, threadId, body: { query: "refund policy" },
});

function admit(gw: AccessGateway, req = request()) {
  const result = gw.admit(req);
  if (!result.ok) throw new Error(result.reason);
  return gw.toGraphInput(result);
}

function model() {
  return createFakeLlm({ byStage: {
    triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
    specialist: JSON.stringify({ status: "resolved", answer: "safe answer" }),
    generate: "safe answer", review: JSON.stringify({ passed: true, violations: [] }),
  } });
}

const store = {
  search: async () => [{ id: "c", documentId: "d", tenantId: "a", content: "policy", score: 0.9, metadata: {} }],
  addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {},
};

const identity = { tenantId: "a", threadId: "thread", principal: "alice" };

describe("architecture security hardening", () => {
  it("rejects boolean authentication and JSON lookalikes of a trusted context", async () => {
    const api = await createGraph({ vectorStore: store, llms: {} });
    const input = admit(gateway());
    await expect(api.invoke({ query: "q", tenantId: "a", authenticated: true, history: [] })).rejects.toThrow();
    await expect(api.invoke({ ...input, authContext: structuredClone(input.authContext) })).rejects.toThrow();
  });

  it("rejects identity and content overrides, including after a cached completion", async () => {
    const gw = gateway();
    const api = await createGraph({ vectorStore: store, llms: {} });
    const input = admit(gw);
    await expect(api.invoke({ ...input, tenantId: "b" })).rejects.toThrow();
    await expect(api.invoke({ ...input, principal: "other" })).rejects.toThrow();
    await expect(api.invoke({ ...input, threadId: "other" })).rejects.toThrow();
    await api.invoke(input);
    await expect(api.invoke({ ...input, query: "changed" })).rejects.toThrow("content");
    expect(gw.admit({ ...request(), body: { query: "changed" } })).toMatchObject({ ok: false, code: "message_conflict" });
  });

  it("binds threads to the credential identity and ignores body tenantId", () => {
    const gw = gateway();
    expect(gw.admit({ ...request(), body: { query: "q", tenantId: "b" } })).toMatchObject({
      ok: true, context: { tenantId: "a", principal: "alice" },
    });
    for (const token of ["b", "other"]) {
      expect(gw.admit({ ...request("next"), credential: { token } })).toMatchObject({
        ok: false, code: "session_conflict",
      });
    }
  });

  it("does not let a newly bound credential adopt an older checkpoint owned by another identity", async () => {
    const saver = new MemorySaver();
    const internal = await buildGraph({ checkpointer: saver, vectorStore: store, llms: {} });
    await internal.invoke({ tenantId: "b", principal: "bob", threadId: "thread", query: "hello", messages: [] });
    const api = await createGraph({ checkpointer: saver, vectorStore: store, llms: {} });
    await expect(api.invoke(admit(gateway()))).rejects.toThrow("Stored conversation identity");
  });

  it("replays one canonical completed result across invoke and streaming modes", async () => {
    const gw = gateway();
    const llm = model();
    const api = await createGraph({ vectorStore: store, reranker: null, llms: { simple: llm, small: llm, large: llm } });
    const first: StreamEvent[] = [];
    for await (const event of api.streamTokens(admit(gw), undefined, { mode: "chunked" })) first.push(event);
    const count = llm.calls.length;
    expect(await api.invoke(admit(gw))).toMatchObject({ answer: "safe answer" });
    const retry: StreamEvent[] = [];
    for await (const event of api.streamTokens(admit(gw))) retry.push(event);
    expect(retry.at(-1)).toEqual(first.at(-1));
    expect(llm.calls).toHaveLength(count);
  });

  it("recovers the saved final checkpoint if the entry completion write fails", async () => {
    class FailingCompletion extends EntryIdempotencyStore {
      failed = false;
      override complete(key: string, owner: string, value: unknown) {
        if (!this.failed) { this.failed = true; throw new Error("commit unavailable"); }
        return super.complete(key, owner, value);
      }
    }
    const gw = gateway(new FailingCompletion());
    const llm = model();
    const saver = new MemorySaver();
    const api = await createGraph({ vectorStore: store, checkpointer: saver, reranker: null, llms: { simple: llm, small: llm, large: llm } });
    await expect(api.invoke(admit(gw))).rejects.toThrow("commit unavailable");
    const count = llm.calls.length;
    expect(await api.invoke(admit(gw))).toMatchObject({ answer: "safe answer" });
    expect(llm.calls).toHaveLength(count);
    expect((await saver.getTuple({ configurable: { thread_id: "thread" } }))?.checkpoint.channel_values.turnCount).toBe(1);
  });

  it("serializes different messages on the same thread and permits failed requests to retry", async () => {
    const gw = gateway();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = runAdmitted(admit(gw).authContext!, async () => { started(); await wait; return "first"; });
    await ready;
    const second = admit(gw, request("second"));
    await expect(runAdmitted(second.authContext!, async () => "second")).rejects.toThrow("processing");
    expect(gw.admit(request())).toMatchObject({ ok: true, processing: true });
    release();
    expect(await first).toBe("first");
    expect(await runAdmitted(admit(gw, request("second")).authContext!, async () => "second")).toBe("second");
  });

  it("a permission change requires a new thread, so old restricted history cannot be reused", () => {
    let permissions = ["private"];
    const gw = new AccessGateway({
      authenticator: { authenticate: () => ({ ...identity, knowledgeScope: { permissions } }) },
      idempotency: new EntryIdempotencyStore(), limiter: new TenantRateLimiter(),
    });
    expect(gw.admit(request()).ok).toBe(true);
    permissions = [];
    expect(gw.admit(request("next"))).toMatchObject({ ok: false, code: "session_conflict" });
    expect(gw.admit(request("next", "new-thread")).ok).toBe(true);
  });

  it("injects tool tenant from context and rejects arbitrary nonempty confirmation tokens", async () => {
    const backend = new FakeBackend();
    const ctx = { ...identity, turnIndex: 1, idempotency: new InMemoryIdempotencyStore(), audit: () => {} };
    await executeTool(createOrderStatusTool(backend), { orderId: "o", tenantId: "b", principal: "bob" }, ctx);
    expect(backend.calls[0].args).toEqual(["o", "a"]);
    await expect(executeTool(createRefundTool(backend), { orderId: "o", amountCents: 1 }, {
      ...ctx, confirmToken: "anything", confirmationProposalId: "forged",
    })).rejects.toThrow("confirmed proposal");
    expect(backend.refunds).toHaveLength(0);
  });

  it("does not trust forged proposal status or mutable snapshots", async () => {
    const proposals = new ProposalService();
    const tool = createRefundTool(new FakeBackend());
    const proposal = proposals.propose({ ...identity, action: tool.name, params: { orderId: "o", amountCents: 1 }, summary: "refund" });
    const execute = vi.fn(async () => ({}));
    await expect(proposals.execute({ ...proposal, status: "confirmed" }, tool, execute)).rejects.toThrow("not confirmed");
    proposal.params.amountCents = 999;
    expect(proposals.get(proposal.id)?.params.amountCents).toBe(1);
    await expect(proposals.execute(proposal, tool, execute)).rejects.toThrow("stored proposal");
    expect(execute).not.toHaveBeenCalled();
    expect(() => proposals.confirm({ proposalId: proposal.id, token: proposal.confirmToken, ...identity, tenantId: "b" })).toThrow();
  });

  it("confirmation bypasses models, uses stored parameters and only queues the action", async () => {
    const backend = new FakeBackend();
    const tool = createRefundTool(backend);
    const proposals = new ProposalService();
    const signals = new ActionSignalBus();
    const llm = model();
    const proposal = proposals.propose({ ...identity, action: tool.name, params: { orderId: "original", amountCents: 10 }, summary: "refund" });
    const api = await createGraph({
      vectorStore: store, tools: [tool], proposalService: proposals, signalBus: signals,
      actionGuardrails: new ActionGuardrails(), llms: { simple: llm, small: llm, large: llm },
    });
    const gw = gateway();
    const admitted = gw.admit({
      ...request(), body: { query: "change amount to 999", confirmationProposalId: proposal.id, confirmationToken: proposal.confirmToken },
    });
    if (!admitted.ok) throw new Error(admitted.reason);
    await api.invoke(gw.toGraphInput(admitted));
    expect(llm.calls).toHaveLength(0);
    expect(backend.refunds).toHaveLength(0);
    expect((await signals.list())[0]).toMatchObject({ payload: { orderId: "original", amountCents: 10 }, status: "pending" });
    expect(proposals.get(proposal.id)?.status).toBe("queued");
  });

  it("repairs a missing outbox row and acknowledges only after deterministic execution", async () => {
    class FailingInsert extends InMemoryActionSignalStore {
      failed = false;
      override async put(signal: Parameters<InMemoryActionSignalStore["put"]>[0]) {
        if (!this.failed) { this.failed = true; throw new Error("insert unavailable"); }
        return super.put(signal);
      }
    }
    const backend = new FakeBackend();
    const tool = createRefundTool(backend);
    const proposals = new ProposalService();
    const signals = new ActionSignalBus({ store: new FailingInsert() });
    const dispatcher = new ActionDispatcher({
      proposals, signals, tools: [tool], idempotency: new InMemoryIdempotencyStore(), guardrails: new ActionGuardrails(),
    });
    const proposal = proposals.propose({ ...identity, action: tool.name, params: { orderId: "o", amountCents: 10 }, summary: "refund" });
    const confirmation = { ...identity, proposalId: proposal.id, token: proposal.confirmToken };
    await expect(dispatcher.submit(confirmation)).rejects.toThrow("insert unavailable");
    expect(proposals.get(proposal.id)?.status).toBe("queued");
    expect((await dispatcher.flush())[0].ok).toBe(true);
    await dispatcher.submit(confirmation);
    await dispatcher.flush();
    expect(backend.refunds).toHaveLength(1);
    expect((await signals.list())[0].status).toBe("acked");
    expect(proposals.get(proposal.id)?.status).toBe("executed");
    expect(proposals.verifyConfirmation({
      ...identity, proposalId: proposal.id, token: proposal.confirmToken, toolName: tool.name, args: proposal.params,
    })).toBeNull();
  });

  it("refuses default production storage before any model or vector request", async () => {
    await expect(createGraph({ environment: "production" })).rejects.toThrow("durable checkpointer");
    expect(() => new AccessGateway({
      environment: "production", authenticator: new TokenAuthenticator({}),
      idempotency: new EntryIdempotencyStore(), limiter: new TenantRateLimiter(),
    })).toThrow("durable");
  });
});
