import { OpenAIEmbeddings } from '@langchain/openai';
import { FakeEmbeddings } from '@langchain/core/utils/testing';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { config } from 'dotenv';

config();

/** 从 .env 创建嵌入模型（USE_FAKE_EMBEDDINGS=false 时走 SiliconFlow 等 OpenAI 兼容 API） */
export function createEmbeddings(): EmbeddingsInterface {
  if (process.env.USE_FAKE_EMBEDDINGS !== 'false') {
    return new FakeEmbeddings();
  }

  return new OpenAIEmbeddings({
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY,
    configuration: process.env.EMBEDDING_BASE_URL
      ? { baseURL: process.env.EMBEDDING_BASE_URL }
      : undefined,
    // ⚠️ 必须显式要 float：不传时 openai SDK 默认请求 `encoding_format:"base64"`，
    // 而模力方舟（api.moark.com）不报错、静默返回畸形响应，SDK 解码后得到
    // 256 维全零向量——检索退化成"所有文档 cosine=0"的随机序，全程无任何异常。
    // 硅基流动/OpenAI 会正确返回 base64，所以这个坑只在换供应商后暴露。
    encodingFormat: 'float',
  });
}
