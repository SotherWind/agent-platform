import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteLeaseStore } from "../../reliability/lease-store";
import { SqliteIdempotencyStore } from "../../tools/idempotency";
import { SqliteEntryIdempotencyStore } from "../../entry-idempotency";
import { SqliteActionSignalStore, ActionSignalBus } from "../../actions/signal";
import { SqliteProposalStore } from "../../actions/proposal-store";
import { ProposalService } from "../../actions/proposal";
import { ActionDispatcher } from "../../actions/dispatcher";
import { ActionGuardrails } from "../../guardrails/action";
import { FakeBackend, createRefundTool } from "../../tools/business";
import { SqliteSessionBindingStore } from "../../session-binding";
import { SqliteKnowledgePublicationStore } from "../../knowledge-publication";
import { SqliteSaver } from "../../sqlite-saver";
import { SqliteTicketStore, TicketService } from "../../tickets";
import { AccessGateway, TokenAuthenticator, TenantRateLimiter } from "../../access";
import { createGraph } from "../../index";
import { createFakeLlm } from "../../llm/fake";

describe("architecture durable recovery (real SQLite, no skip)", () => {
  let directory = "";
  let path = "";
  let opened: Array<{ close(): void }> = [];
  const track = <T extends { close(): void }>(store: T): T => { opened.push(store); return store; };
  const closeAll = () => { for (const store of opened.splice(0).reverse()) store.close(); };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rag-architecture-"));
    path = join(directory, "state.sqlite");
  });
  afterEach(() => {
    closeAll();
    if (!directory.startsWith(join(tmpdir(), "rag-architecture-"))) throw new Error("Unexpected temporary directory.");
    rmSync(directory, { recursive: true, force: true });
  });

  it("allows only one of two actual processes to claim the same operation", async () => {
    track(new SqliteLeaseStore(path, "process-contention"));
    const worker = fileURLToPath(new URL("../helpers/lease-worker.ts", import.meta.url));
    const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", worker, path], { windowsHide: true });
    const claims = (await Promise.all([run(), run()])).map(({ stdout }) => JSON.parse(stdout));
    expect(claims.filter((claim) => claim.status === "acquired")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "busy")).toHaveLength(1);
  });

  it("fences stale lease owners and restores the winning result after reopening", () => {
    const first = track(new SqliteLeaseStore(path, "lease"));
    const second = track(new SqliteLeaseStore(path, "lease"));
    const old = first.claim("key", "body", 100, 50);
    if (old.status !== "acquired") throw new Error("Expected first claim.");
    expect(second.claim("key", "different", 101, 50).status).toBe("conflict");
    expect(second.claim("key", "body", 110, 50).status).toBe("busy");
    const next = second.claim("key", "body", 151, 50);
    if (next.status !== "acquired") throw new Error("Expected replacement claim.");
    expect(first.complete("key", old.owner, "stale", 152)).toBe(false);
    expect(first.renew("key", old.owner, 152, 50)).toBe(false);
    expect(second.complete("key", next.owner, { answer: "winner" }, 153)).toBe(true);
    closeAll();
    expect(track(new SqliteLeaseStore(path, "lease")).claim("key", "body", 160, 50)).toEqual({
      status: "completed", result: { answer: "winner" },
    });
  });

  it("uses atomic signal claims, persists responses and rejects stale acknowledgements", async () => {
    const first = track(new SqliteActionSignalStore(path));
    const second = track(new SqliteActionSignalStore(path));
    const bus = new ActionSignalBus({ store: first });
    const signal = await bus.emit({
      type: "refund", tenantId: "a", principal: "p", threadId: "th",
      idempotencyKey: "key", payload: {},
    });
    const old = await first.claim(signal.id, 100, 50);
    if (old.status !== "acquired") throw new Error("Expected claim.");
    expect((await second.claim(signal.id, 101, 50)).status).toBe("busy");
    const next = await second.claim(signal.id, 151, 50);
    if (next.status !== "acquired") throw new Error("Expected recovered claim.");
    expect(await first.complete(signal.id, old.owner, {}, 152)).toBe(false);
    expect(await first.fail(signal.id, old.owner, "stale", 152)).toBe(false);
    expect(await second.complete(signal.id, next.owner, { result: "ok" }, 152)).toBe(true);
    closeAll();
    expect(await track(new SqliteActionSignalStore(path)).get(signal.id)).toMatchObject({
      status: "acked", attempts: 2, response: { result: "ok" },
    });
  });

  it("restarts between confirmation and execution without repeating a business effect", async () => {
    const secret = "durable-test-secret-with-at-least-32-bytes";
    const backend = new FakeBackend();
    const tool = createRefundTool(backend);
    const assemble = () => {
      const proposals = new ProposalService({ secret, store: track(new SqliteProposalStore(path)) });
      const signals = new ActionSignalBus({ store: track(new SqliteActionSignalStore(path)) });
      const dispatcher = new ActionDispatcher({
        proposals, signals, tools: [tool], idempotency: track(new SqliteIdempotencyStore({ path })),
        guardrails: new ActionGuardrails(),
      });
      return { proposals, signals, dispatcher };
    };
    const first = assemble();
    const identity = { tenantId: "a", principal: "p", threadId: "thread" };
    const proposal = first.proposals.propose({ ...identity, action: tool.name, params: { orderId: "o", amountCents: 10 }, summary: "refund" });
    const confirmation = { ...identity, proposalId: proposal.id, token: proposal.confirmToken };
    await first.dispatcher.submit(confirmation);
    closeAll();
    const second = assemble();
    await second.dispatcher.flush();
    expect(second.proposals.get(proposal.id)?.status).toBe("executed");
    closeAll();
    const third = assemble();
    await third.dispatcher.submit(confirmation);
    await third.dispatcher.flush();
    expect(backend.refunds).toHaveLength(1);
    expect((await third.signals.list())[0].status).toBe("acked");
    expect(third.proposals.productionReady).toBe(true);
  });

  it("persists session ownership, knowledge generations and ticket lifecycle records", async () => {
    const sessions = track(new SqliteSessionBindingStore(path));
    sessions.bind({ tenantId: "a", principal: "p", threadId: "th" });
    const publications = track(new SqliteKnowledgePublicationStore(path));
    const first = publications.publish({ tenantId: "a", documentId: "d", generations: ["v1"], legacy: false });
    publications.publish({ tenantId: "a", documentId: "d", generations: ["v2"], legacy: false }, first.revision);
    expect(() => publications.publish({ tenantId: "a", documentId: "d", generations: ["stale"], legacy: false }, first.revision)).toThrow();
    const tickets = new TicketService({ store: track(new SqliteTicketStore(path)) });
    const ticket = await tickets.create({ tenantId: "a", threadId: "th", idempotencyKey: "ticket-key" });
    closeAll();
    expect(() => track(new SqliteSessionBindingStore(path)).bind({ tenantId: "b", principal: "p", threadId: "th" })).toThrow();
    expect(track(new SqliteKnowledgePublicationStore(path)).get("a", "d")?.generations).toEqual(["v2"]);
    const restored = new TicketService({ store: track(new SqliteTicketStore(path)) });
    expect((await restored.create({ tenantId: "a", threadId: "th", idempotencyKey: "ticket-key" })).id).toBe(ticket.id);
    expect(await restored.list({ tenantId: "a" })).toHaveLength(1);
  });

  it("production assembly restores checkpoints and replays completed messages without a model call", async () => {
    const llm = createFakeLlm({ byStage: {
      triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
      specialist: JSON.stringify({ status: "resolved", answer: "answer" }),
      generate: "answer", review: JSON.stringify({ passed: true, violations: [] }),
    } });
    const assemble = async () => {
      const gw = new AccessGateway({
        environment: "production", authenticator: new TokenAuthenticator({ token: { tenantId: "a", principal: "p" } }),
        idempotency: track(new SqliteEntryIdempotencyStore({ path })), limiter: new TenantRateLimiter(),
        sessionBindings: track(new SqliteSessionBindingStore(path)),
      });
      const graph = await createGraph({
        environment: "production", checkpointer: track(new SqliteSaver({ path })),
        idempotency: track(new SqliteIdempotencyStore({ path })),
        ticketService: new TicketService({ store: track(new SqliteTicketStore(path)) }),
        proposalService: new ProposalService({ secret: "explicit-test-secret-at-least-32-bytes", store: track(new SqliteProposalStore(path)) }),
        signalBus: new ActionSignalBus({ store: track(new SqliteActionSignalStore(path)) }),
        tools: [createRefundTool(new FakeBackend())], actionGuardrails: new ActionGuardrails(),
        llms: { simple: llm, small: llm, large: llm }, reranker: null,
        vectorStore: {
          search: async () => [{ id: "c", documentId: "d", tenantId: "a", content: "policy", score: 0.9, metadata: {} }],
          addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {},
        },
      });
      const admission = gw.admit({ credential: { token: "token" }, messageId: "m", threadId: "th", body: { query: "policy" } });
      if (!admission.ok) throw new Error(admission.reason);
      return { graph, input: gw.toGraphInput(admission) };
    };
    const first = await assemble();
    const result = await first.graph.invoke(first.input);
    const calls = llm.calls.length;
    closeAll();
    const second = await assemble();
    expect(await second.graph.invoke(second.input)).toEqual(result);
    expect(llm.calls).toHaveLength(calls);
    await expect(second.graph.streamTokens(second.input, undefined, { mode: "async" }).next()).rejects.toThrow("strict");
  });

  it("never treats an in-memory SQLite connection as production durable storage", () => {
    expect(track(new SqliteSaver()).durable).toBe(false);
    expect(track(new SqliteActionSignalStore()).durable).toBe(false);
    expect(track(new SqliteTicketStore(":memory:")).durable).toBe(false);
  });
});
