import assert from "node:assert/strict";
import { createMetadataStack, shouldUseVectorMetadata } from "../../src/metadata/metadata-factory.js";
import { VectorSchemaRetriever } from "../../src/metadata/vector-schema-retriever.js";
import { QdrantVectorIndexBackend } from "../../src/metadata/qdrant-backend.js";
import { InMemoryVectorIndexBackend } from "../../src/metadata/vector-backend.js";
import { test, section } from "../helpers/runner.js";

export async function testMetadataFactory() {
  section("Metadata Factory (bootstrap 接线)");

  await test("无 QDRANT_URL 时使用 InMemory 后端", () => {
    const stack = createMetadataStack({ qdrantUrl: "" });
    assert.ok(stack.backend instanceof InMemoryVectorIndexBackend);
    assert.ok(stack.retriever instanceof VectorSchemaRetriever);
    assert.ok(stack.indexer);
  });

  await test("有 QDRANT_URL 时使用 Qdrant 后端", () => {
    const stack = createMetadataStack({
      qdrantUrl: "http://127.0.0.1:6333",
    });
    assert.ok(stack.backend instanceof QdrantVectorIndexBackend);
  });

  await test("shouldUseVectorMetadata 识别开关", () => {
    assert.equal(shouldUseVectorMetadata({ BI_METADATA_VECTOR: "1" }), true);
    assert.equal(
      shouldUseVectorMetadata({ QDRANT_URL: "http://127.0.0.1:6333" }),
      true,
    );
    assert.equal(shouldUseVectorMetadata({}), false);
  });
}
