import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createGraph, Prefilter, TicketService } from "@agent-platform/rag-boot";
import { loadServerConfig } from "../src/config.js";
import { AuthService } from "../src/auth.js";
import { buildAccessGateway } from "../src/gateway.js";
import { handleRequest } from "../src/http.js";
import { assertNativeRuntimeCompatibility } from "../src/runtime.js";

describe("production configuration", () => {
  const valid = {
    NODE_ENV: "production", RAGBOT_DATA_DIR: "./data",
    RAGBOT_PROPOSAL_SECRET: "test-explicit-secret-with-at-least-32-bytes",
    RAGBOT_BUSINESS_MODULE: "./business-adapter.ts",
  };

  it("defaults to strict review and durable development storage", () => {
    expect(loadServerConfig({})).toMatchObject({ reviewStreamMode: "strict", dataDir: "./data" });
    expect(loadServerConfig(valid)).toMatchObject({ environment: "production", autoIngest: false });
  });

  it("refuses missing storage, weak secrets, unsafe streaming and demo backends in production", () => {
    expect(() => loadServerConfig({ ...valid, RAGBOT_DATA_DIR: "" })).toThrow("DATA_DIR");
    expect(() => loadServerConfig({ ...valid, RAGBOT_PROPOSAL_SECRET: "weak" })).toThrow("SECRET");
    expect(() => loadServerConfig({ ...valid, REVIEW_STREAM_MODE: "chunked" })).toThrow("strict");
    expect(() => loadServerConfig({ ...valid, USE_FAKE_LLM: "true" })).toThrow("fake LLM");
    expect(() => loadServerConfig({ ...valid, USE_FAKE_EMBEDDINGS: "true" })).toThrow("fake embeddings");
    expect(() => loadServerConfig({ ...valid, RAGBOT_BUSINESS_MODULE: "" })).toThrow("BUSINESS_MODULE");
  });

  it("loads knowledge grants from server configuration, not client messages", () => {
    const config = loadServerConfig({
      RAGBOT_USERS: "alice:password:a",
      RAGBOT_KNOWLEDGE_SCOPES: JSON.stringify([
        { tenantId: "a", principal: "alice", products: ["pro"], permissions: ["billing"] },
      ]),
    });
    const auth = new AuthService(config);
    const token = auth.login("alice", "password")!.token;
    expect(auth.authenticate({ token })?.knowledgeScope).toMatchObject({ products: ["pro"], permissions: ["billing"] });
    expect(() => loadServerConfig({ RAGBOT_KNOWLEDGE_SCOPES: '[{"tenantId":"a","principal":"p","roles":"admin"}]' })).toThrow("string array");
  });
});

describe("native runtime guard", () => {
  it("当前 Node 运行时可以创建 better-sqlite3 数据库", () => {
    expect(() => assertNativeRuntimeCompatibility()).not.toThrow();
  });
});

describe("HTTP admitted replay with the real core", () => {
  let server: Server;
  let url: string;
  let token: string;
  let otherToken: string;
  const prefilter = new Prefilter({ faqs: [{ id: "test", patterns: [/^policy$/], answer: "approved answer" }] });
  const config = loadServerConfig({
    RAGBOT_USERS: "alice:password:a,bob:password:b", STREAM_CHUNK_DELAY_MS: "0", CORS_ORIGIN: "",
  });
  beforeAll(async () => {
    const auth = new AuthService(config);
    token = auth.login("alice", "password")!.token;
    otherToken = auth.login("bob", "password")!.token;
    const gw = buildAccessGateway(auth);
    const graph = await createGraph({
      prefilter, llms: {}, reranker: null,
      vectorStore: {
        search: async () => [], addDocuments: async () => 0,
        ingestFile: async () => 0, deleteByDocumentId: async () => {},
      },
    });
    const deps = { config, authService: auth, gateway: gw, graph, ticketService: new TicketService() };
    server = createServer((req, res) => { void handleRequest(deps, req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address.");
    url = `http://127.0.0.1:${address.port}/api/chat`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const post = (body: object, authToken = token) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  const answer = async (response: Response) => (await response.text())
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)))
    .filter((frame) => frame.type === "text-delta")
    .map((frame) => frame.delta)
    .join("");

  it("replays the actual completed answer instead of returning an empty completion stream", async () => {
    const body = { messageId: "same", threadId: "thread", query: "policy", tenantId: "forged" };
    const first = await post(body);
    expect(first.status).toBe(200);
    expect(await answer(first)).toBe("approved answer");
    const calls = prefilter.metrics().total;
    const second = await post(body);
    expect(second.status).toBe(200);
    expect(await answer(second)).toBe("approved answer");
    expect(prefilter.metrics().total).toBe(calls);
  });

  it("returns conflict for changed retry content and another identity's thread", async () => {
    expect((await post({ messageId: "same", threadId: "thread", query: "changed" })).status).toBe(409);
    expect((await post({ messageId: "other", threadId: "thread", query: "policy" }, otherToken)).status).toBe(409);
  });

  it("uses a stable fallback thread when the caller supplies only messageId", async () => {
    const first = await post({ messageId: "no-thread", query: "policy" });
    await first.text();
    const retry = await post({ messageId: "no-thread", query: "policy" });
    expect(retry.status).toBe(200);
    expect(await answer(retry)).toBe("approved answer");
  });
});
