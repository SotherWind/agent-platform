import { StateGraph, START, END } from "@langchain/langgraph";
import type {
  BuildGraphConfig,
  State,
  VectorStoreType,
  Reranker,
  AgentGraphNode,
} from "./type";
import { createVectorStore } from "./vectorstore";
import { createApiReranker } from "./rerank";
import { AgentState } from "./state";
import { createRetrieveContextTool } from "./tools";
import { RetrieveContextToolInputSchema } from "./schema";
import { getTracingCallbacks } from "./observability";

/**
 * retrieveNode：向量检索
 * - Fail-closed：缺失 tenantId 直接拒绝
 * - Metadata filtering：只检索当前租户的文档
 */
const createRetrieveNode = (store: VectorStoreType) => {
  return async (state: State) => {
    // Fail-closed 约束：缺失 tenantId 直接拒绝
    if (!state.tenantId) {
      throw new Error("tenantId is required. Request rejected.");
    }

    // Parse and validate using Zod
    const input = RetrieveContextToolInputSchema.parse({
      query: state.query,
      tenantId: state.tenantId,
      topK: 20,
      topN: 5,
    });

    const retrieveContext = createRetrieveContextTool(store);

    const toolResult = await retrieveContext.invoke(input);

    // Metadata filtering 后结果为空
    if (toolResult.length === 0) {
      return {
        retrievedDocs: [],
        rerankedDocs: [],
        finalAnswer: "当前租户下无可用数据，请提供更多上下文或更换查询词",
        citations: [],
      };
    }

    return {
      retrievedDocs: toolResult,
    };
  };
};

/**
 * rerankNode：重排序
 * - 对检索结果进行二次排序，提升 Precision
 * - 默认使用 Mock Rerank（关键词匹配），生产替换为 Cohere Rerank
 */
const createRerankNode = (reranker: Reranker) => {
  return async (state: State) => {
    const { retrievedDocs, query } = state;
    if (retrievedDocs.length === 0) {
      return {};
    }

    const rerankedDocs = await reranker.rerank(query, retrievedDocs, 5);

    return {
      rerankedDocs,
    };
  };
};

/**
 * generateNode：生成回答
 * - 纵深防御：二次过滤跨租户数据
 * - 生成答案 + 引用来源
 */
const generateNode: AgentGraphNode = async (state) => {
  const { rerankedDocs } = state;

  if (rerankedDocs.length === 0) {
    return {};
  }

  // 纵深防御：二次过滤，确保 citations 全部属于当前租户
  const safeDocs = rerankedDocs.filter(
    (doc) => doc.tenantId === state.tenantId,
  );

  const citations = safeDocs.map((doc) => ({
    chunkId: doc.id,
    documentId: doc.documentId,
    tenantId: doc.tenantId,
    text: doc.content,
  }));

  const answer =
    safeDocs.length > 0
      ? `Based on the context, here is the answer to your query: ${state.query}. Evidence: ${safeDocs.map((d) => d.content).join(" ")}`
      : "未检索到相关知识，请确认租户权限或扩充知识库。";

  return {
    finalAnswer: answer,
    citations,
  };
};

export const buildGraph = async (configs: BuildGraphConfig = {}) => {
  const { checkpointer, vectorStore, reranker } = configs;

  const store = vectorStore ?? (await createVectorStore());
  const apiReranker = reranker ?? createApiReranker();

  const retrieveNode = createRetrieveNode(store);
  const rerankNode = createRerankNode(apiReranker);

  const workflow = new StateGraph(AgentState)
    .addNode("retrieve", retrieveNode)
    .addNode("rerank", rerankNode)
    .addNode("generate", generateNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "rerank")
    .addEdge("rerank", "generate")
    .addEdge("generate", END);

  const compiled = workflow.compile({ checkpointer });

  const originalInvoke = compiled.invoke.bind(compiled);
  const originalStream = compiled.stream.bind(compiled);

  const injectCallbacks = (config?: any) => {
    const callbacks = getTracingCallbacks();
    let existing = config?.callbacks || [];
    if (!Array.isArray(existing)) {
      existing = [existing];
    }
    return { ...config, callbacks: [...existing, ...callbacks] };
  };

  return Object.assign(compiled, {
    invoke: async (
      state: Parameters<typeof originalInvoke>[0],
      config?: Parameters<typeof originalInvoke>[1],
    ) => {
      return originalInvoke(state, injectCallbacks(config));
    },
    stream: async (
      state: Parameters<typeof originalStream>[0],
      config?: Parameters<typeof originalStream>[1],
    ) => {
      return originalStream(state, injectCallbacks(config));
    },
  });
};
