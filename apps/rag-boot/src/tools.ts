import { tool } from '@langchain/core/tools';
import type { VectorStoreType, RetrieveContextToolInput } from "./type";
import { RetrieveContextToolInputSchema } from "./schema";

export function createRetrieveContextTool(vectorStore: VectorStoreType) {
  return tool(
    async (input: RetrieveContextToolInput) => {
      // Metadata filtering：在向量检索时即过滤，只返回当前租户文档
      const docs = await vectorStore.search(input.query, input.tenantId, input.topK);

      return docs.slice(0, input.topN);
    },
    {
      name: 'retrieve_context',
      description: '从知识库中检索与查询相关的文档片段。需要提供 tenantId 以确保只检索到当前租户有权访问的文档。',
      schema: RetrieveContextToolInputSchema,
    }
  );
}