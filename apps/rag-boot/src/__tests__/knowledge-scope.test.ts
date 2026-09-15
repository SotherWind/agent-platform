import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import { knowledgeFilter } from "../vectorstore";
import { retrieve } from "../nodes/retrieve";
import { matchesKnowledgeScope } from "../knowledge-scope";
import { AccessGateway, EntryIdempotencyStore, TenantRateLimiter, TokenAuthenticator } from "../access";
import { createGraph } from "../index";
import { createFakeLlm } from "../llm/fake";
import { fakeQdrant, matchesFilter, testVectorStore } from "./helpers/fake-qdrant";

const scope = { products: ["pro"], regions: ["cn"], roles: ["support"], permissions: ["billing", "refund"] };
const restrictions = { products: ["pro"], regions: ["cn"], roles: ["support"], permissions: ["billing", "refund"] };

describe("knowledge scope enforcement", () => {
  it("filters tenant, product, region, role and all required permissions in Qdrant and application code", () => {
    const doc = (metadata: object) => new Document({ pageContent: "private", metadata: { tenantId: "a", ...metadata } });
    const allowed = doc(restrictions);
    expect(matchesKnowledgeScope(allowed.metadata, scope)).toBe(true);
    expect(matchesFilter(allowed, knowledgeFilter("a", Date.now(), scope))).toBe(true);
    for (const key of ["products", "regions", "roles", "permissions"] as const) {
      const denied = { ...scope, [key]: [] };
      expect(matchesKnowledgeScope(allowed.metadata, denied)).toBe(false);
      expect(matchesFilter(allowed, knowledgeFilter("a", Date.now(), denied))).toBe(false);
    }
    expect(matchesKnowledgeScope(restrictions, { ...scope, permissions: ["billing"] })).toBe(false);
    expect(matchesKnowledgeScope({ roles: "admin" }, scope)).toBe(false);
    expect(matchesKnowledgeScope({}, {})).toBe(true);
    expect(matchesFilter(doc({}), knowledgeFilter("b", Date.now(), scope))).toBe(false);
  });

  it("rejects dirty retrieval results before any reranker or model sees them", async () => {
    const fake = {
      search: async () => [
        { id: "private", documentId: "d", tenantId: "a", content: "secret", score: 1, metadata: restrictions },
        { id: "cross", documentId: "d", tenantId: "b", content: "other tenant", score: 1, metadata: {} },
        { id: "expired", documentId: "d", tenantId: "a", content: "expired", score: 1, metadata: { expiredAt: 1 } },
        { id: "public", documentId: "d", tenantId: "a", content: "public", score: 1, metadata: {} },
      ],
      addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {},
    };
    const result = await retrieve(fake, { query: "q", tenantId: "a", scope: {} });
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["public"]);
  });

  it("takes grants from credentials, ignoring a request-body permission claim", async () => {
    const seen: unknown[] = [];
    const store = {
      search: async (_q: string, _tenant: string, _k: number, received: unknown) => {
        seen.push(received);
        return [];
      },
      addDocuments: async () => 0, ingestFile: async () => 0, deleteByDocumentId: async () => {},
    };
    const llm = createFakeLlm({ byStage: {
      triage: JSON.stringify({ categories: ["general"], urgency: "normal", likelyNeedsHuman: false, needsRealtimeData: false }),
      specialist: JSON.stringify({ status: "resolved", answer: "answer" }),
    } });
    const api = await createGraph({ vectorStore: store, reranker: null, llms: { simple: llm, small: llm, large: llm } });
    const gw = new AccessGateway({
      authenticator: new TokenAuthenticator({ token: { tenantId: "a", principal: "p", knowledgeScope: scope } }),
      idempotency: new EntryIdempotencyStore(), limiter: new TenantRateLimiter(),
    });
    const result = gw.admit({
      credential: { token: "token" }, messageId: "m", body: { query: "policy", knowledgeScope: { permissions: ["admin"] } },
    });
    if (!result.ok) throw new Error(result.reason);
    await api.invoke(gw.toGraphInput(result));
    expect(seen).toEqual([scope]);
  });

  it("persists restrictions on every chunk and does not allow empty tenant queries", async () => {
    const store = testVectorStore(fakeQdrant());
    await store.addDocuments([new Document({ pageContent: "private", metadata: {} })], {
      tenantId: "a", documentId: "d", knowledgeScope: restrictions,
    });
    expect(await store.search("q", "a", 10)).toEqual([]);
    expect(await store.search("q", "a", 10, scope)).toHaveLength(1);
    await expect(store.search("q", "", 10, scope)).rejects.toThrow();
  });
});
