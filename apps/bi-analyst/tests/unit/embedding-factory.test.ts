import assert from "node:assert/strict";
import {
  createEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
  parseEmbeddingConfig,
} from "../../src/metadata/embedding-factory.js";
import { DeterministicEmbeddingProvider } from "../../src/metadata/embeddings.js";
import { test, section } from "../helpers/runner.js";

export async function testEmbeddingFactory() {
  section("Embedding Factory");

  await test("test 环境默认 deterministic", () => {
    const config = parseEmbeddingConfig({ APP_ENV: "test" });
    assert.equal(config.provider, "deterministic");
    assert.equal(config.useFake, true);

    const provider = createEmbeddingProvider({ APP_ENV: "test" });
    assert.ok(provider instanceof DeterministicEmbeddingProvider);
  });

  await test("USE_FAKE_EMBEDDINGS=true 时使用 deterministic", () => {
    const config = parseEmbeddingConfig({
      USE_FAKE_EMBEDDINGS: "true",
      EMBEDDING_API_KEY: "sk-test",
      EMBEDDING_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_MODEL: "test-model",
    });
    assert.equal(config.provider, "deterministic");
    assert.equal(config.useFake, true);
  });

  await test("完整配置时使用 OpenAI 兼容 provider", () => {
    const config = parseEmbeddingConfig({
      APP_ENV: "development",
      USE_FAKE_EMBEDDINGS: "false",
      EMBEDDING_API_KEY: "sk-test",
      EMBEDDING_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-0.6B",
      EMBEDDING_VECTOR_SIZE: "1024",
    });
    assert.equal(config.provider, "openai-compatible");
    assert.equal(config.vectorSize, 1024);

    const provider = createEmbeddingProvider({
      APP_ENV: "development",
      USE_FAKE_EMBEDDINGS: "false",
      EMBEDDING_API_KEY: "sk-test",
      EMBEDDING_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-0.6B",
      EMBEDDING_VECTOR_SIZE: "1024",
    });
    assert.ok(provider instanceof OpenAiCompatibleEmbeddingProvider);
    assert.equal(provider.vectorSize, 1024);
  });

  await test("OpenAiCompatibleEmbeddingProvider 解析 API 响应", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: [
            { index: 0, embedding: Array.from({ length: 4 }, (_, i) => i + 1) },
            { index: 1, embedding: Array.from({ length: 4 }, (_, i) => i + 2) },
          ],
        }),
      }) as Response;

    try {
      const provider = new OpenAiCompatibleEmbeddingProvider({
        apiKey: "sk-test",
        baseUrl: "https://api.example.com/v1",
        model: "test-model",
        vectorSize: 4,
      });
      const vectors = await provider.embed(["hello", "world"]);
      assert.equal(vectors.length, 2);
      assert.equal(vectors[0].length, 4);
      assert.deepEqual(vectors[0], [1, 2, 3, 4]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
