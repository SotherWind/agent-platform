import type { EmbeddingProvider } from "./embeddings.js";
import { DeterministicEmbeddingProvider } from "./embeddings.js";

export interface EmbeddingConfig {
  provider: "deterministic" | "openai-compatible";
  model: string;
  baseUrl?: string;
  vectorSize: number;
  useFake: boolean;
}

export interface OpenAiEmbeddingOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  vectorSize?: number;
  timeoutMs?: number;
}

/** OpenAI 兼容 /embeddings 接口（SiliconFlow、OpenAI 等） */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion: string;
  readonly vectorSize: number;

  constructor(private readonly options: OpenAiEmbeddingOptions) {
    this.modelVersion = options.model;
    this.vectorSize = options.vectorSize ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.options.baseUrl.replace(/\/$/, "")}/embeddings`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 30_000,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Embedding API 失败 (${response.status}): ${detail.slice(0, 200)}`,
        );
      }

      const body = (await response.json()) as {
        data?: Array<{ index: number; embedding: number[] }>;
      };

      const rows = body.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(
          `Embedding API 返回数量不匹配：期望 ${texts.length}，实际 ${rows.length}`,
        );
      }

      const vectors = rows
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding);

      for (const vector of vectors) {
        if (vector.length !== this.vectorSize) {
          throw new Error(
            `Embedding 维度不匹配：期望 ${this.vectorSize}，实际 ${vector.length}`,
          );
        }
      }

      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig {
  const useFake =
    env.APP_ENV === "test" ||
    env.USE_FAKE_EMBEDDINGS === "true" ||
    env.USE_FAKE_EMBEDDINGS === "1" ||
    env.BI_USE_DETERMINISTIC_EMBEDDINGS === "1";

  const model = env.EMBEDDING_MODEL ?? "deterministic-v1";
  const vectorSize = Number(env.EMBEDDING_VECTOR_SIZE ?? 1024);

  if (useFake) {
    return {
      provider: "deterministic",
      model: "deterministic-v1",
      vectorSize: Number(env.EMBEDDING_VECTOR_SIZE ?? 64),
      useFake: true,
    };
  }

  const apiKey = env.EMBEDDING_API_KEY;
  const baseUrl = env.EMBEDDING_BASE_URL;
  if (apiKey && baseUrl && model) {
    return {
      provider: "openai-compatible",
      model,
      baseUrl,
      vectorSize,
      useFake: false,
    };
  }

  return {
    provider: "deterministic",
    model: "deterministic-v1",
    vectorSize: Number(env.EMBEDDING_VECTOR_SIZE ?? 64),
    useFake: true,
  };
}

export function createEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const config = parseEmbeddingConfig(env);

  if (config.provider === "openai-compatible") {
    const apiKey = env.EMBEDDING_API_KEY;
    const baseUrl = env.EMBEDDING_BASE_URL;
    if (!apiKey || !baseUrl) {
      throw new Error("Embedding 配置不完整：缺少 EMBEDDING_API_KEY 或 EMBEDDING_BASE_URL");
    }
    return new OpenAiCompatibleEmbeddingProvider({
      apiKey,
      baseUrl,
      model: config.model,
      vectorSize: config.vectorSize,
    });
  }

  return new DeterministicEmbeddingProvider(config.vectorSize);
}

/** 启动日志用，不含密钥 */
export function summarizeEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const config = parseEmbeddingConfig(env);
  return {
    provider: config.provider,
    model: config.model,
    vectorSize: config.vectorSize,
    useFake: config.useFake,
    baseUrl: config.baseUrl ? "[configured]" : undefined,
  };
}
