import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import type { VectorStoreType } from "@agent-platform/rag-boot";
import { loadServerConfig } from "../src/config.js";
import { autoIngestKnowledge } from "../src/ingest.js";

const mocks = vi.hoisted(() => ({ count: vi.fn(), readdir: vi.fn() }));
vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    count = mocks.count;
  },
}));
vi.mock("node:fs/promises", () => ({ readdir: mocks.readdir }));

const config = () => loadServerConfig({
  AUTO_INGEST: "true",
  KNOWLEDGE_DIR: "./knowledge",
  RAGBOT_USERS: "alice:password:a,amy:password:a,bob:password:b",
});
const vectorStore = (): VectorStoreType => ({
  search: vi.fn(async () => []),
  addDocuments: vi.fn(async () => 0),
  ingestFile: vi.fn(async () => 2),
  deleteByDocumentId: vi.fn(async () => {}),
});

describe("automatic knowledge ingestion", () => {
  beforeEach(() => {
    vi.stubEnv("QDRANT_URL", "http://qdrant.test");
    vi.stubEnv("QDRANT_API_KEY", "");
    vi.stubEnv("QDRANT_COLLECTION_NAME", undefined);
    mocks.count.mockReset().mockResolvedValue({ count: 0 });
    mocks.readdir.mockReset().mockResolvedValue(["policy.md", "ignore.txt"]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses the reader's store and default collection, once per unique tenant", async () => {
    const store = vectorStore();
    await autoIngestKnowledge(config(), store);
    expect(mocks.count).toHaveBeenCalledWith("rag_boot");
    expect(store.ingestFile).toHaveBeenCalledTimes(2);
    for (const tenantId of ["a", "b"]) {
      expect(store.ingestFile).toHaveBeenCalledWith(join(resolve("./knowledge"), "policy.md"), {
        tenantId, documentId: "policy", source: "policy.md",
      });
    }
  });

  it("allows first ingestion when the collection count returns 404", async () => {
    mocks.count.mockRejectedValue({ status: 404 });
    const store = vectorStore();
    await autoIngestKnowledge(config(), store);
    expect(store.ingestFile).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 500, 503])("does not treat Qdrant HTTP %s as an empty collection", async (status) => {
    mocks.count.mockRejectedValue({ status });
    const store = vectorStore();
    await autoIngestKnowledge(config(), store);
    expect(store.ingestFile).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not ingest on a network failure", async () => {
    mocks.count.mockRejectedValue(new Error("connection refused"));
    const store = vectorStore();
    await autoIngestKnowledge(config(), store);
    expect(store.ingestFile).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("honors the configured collection and leaves existing knowledge untouched", async () => {
    vi.stubEnv("QDRANT_COLLECTION_NAME", "customer_service");
    mocks.count.mockResolvedValue({ count: 1 });
    const store = vectorStore();
    await autoIngestKnowledge(config(), store);
    expect(mocks.count).toHaveBeenCalledWith("customer_service");
    expect(store.ingestFile).not.toHaveBeenCalled();
  });

  it("does not inspect or write knowledge when automatic ingestion is disabled", async () => {
    const store = vectorStore();
    await autoIngestKnowledge({ ...config(), autoIngest: false }, store);
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(store.ingestFile).not.toHaveBeenCalled();
  });
});
