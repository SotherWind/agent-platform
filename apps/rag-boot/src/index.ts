import { buildGraph } from "./agent";
import {
  RagBotInput,
  RagBotOutput,
  ChatMessage,
  CreateGraphOptions,
} from "./type";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";

const convertMessages = (messages: ChatMessage[]) => {
  return messages.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    if (m.role === "system") return new SystemMessage(m.content);
    return new HumanMessage(m.content);
  });
};

export function createGraph(options?: CreateGraphOptions) {
  const graph = buildGraph(options);

  return {
    invoke: async (input: RagBotInput, config?: any): Promise<RagBotOutput> => {
      const result = await graph.invoke(
        {
          query: input.query,
          tenantId: input.tenantId,
          messages: convertMessages(input.history),
        },
        config,
      );

      return {
        answer: result.finalAnswer,
        sources: result.citations
          ? result.citations.map((c: any) => c.text)
          : [],
      };
    },
    stream: async (input: RagBotInput, config?: any) => {
      return graph.stream(
        {
          query: input.query,
          tenantId: input.tenantId,
          messages: convertMessages(input.history),
        },
        config,
      );
    },
  };
}

export * from "./type";
export * from "./schema";
export * from "./state";
export * from "./tools";
export * from "./agent";
export * from "./vectorstore";
export * from "./rerank";
