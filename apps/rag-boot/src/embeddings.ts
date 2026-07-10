import { OpenAIEmbeddings } from "@langchain/openai";
import { FakeEmbeddings } from "@langchain/core/utils/testing";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { config } from "dotenv";

config();

/** 从 .env 创建嵌入模型（USE_FAKE_EMBEDDINGS=false 时走 SiliconFlow 等 OpenAI 兼容 API） */
export function createEmbeddings(): EmbeddingsInterface {
  if (process.env.USE_FAKE_EMBEDDINGS !== "false") {
    return new FakeEmbeddings();
  }

  return new OpenAIEmbeddings({
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY,
    configuration: process.env.EMBEDDING_BASE_URL
      ? { baseURL: process.env.EMBEDDING_BASE_URL }
      : undefined,
  });
}
