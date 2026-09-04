import { buildGraph } from "./agent";
import { TenantMissingError } from "./errors";
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

export async function createGraph(options?: CreateGraphOptions) {
  const graph = await buildGraph(options);

  return {
    invoke: async (input: RagBotInput, config?: any): Promise<RagBotOutput> => {
      if (!input.authenticated) {
        throw new TenantMissingError("AccessGateway authentication is required before graph invocation.", {
          stage: "access",
        });
      }
      const result = await graph.invoke(
        {
          query: input.query,
          tenantId: input.tenantId,
          threadId: input.threadId,
          principal: input.principal,
          confirmationProposalId: input.confirmationProposalId,
          confirmationToken: input.confirmationToken,
          messages: convertMessages(input.history),
          transcriptConfidence: input.transcriptConfidence ?? null,
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
    /**
     * T9.4 采用「先审后发」策略：先完整执行图并完成输出 Guardrails / Reviewer，
     * 再把已通过终审的 finalAnswer 分块发送。这样高风险回复不存在“已发出才被拦回”的路径；
     * 客户端中断发生在 checkpoint 已落盘之后，不会丢失会话状态。
     */
    stream: async function* (input: RagBotInput, config?: any): AsyncGenerator<string> {
      if (!input.authenticated) {
        throw new TenantMissingError("AccessGateway authentication is required before graph streaming.", {
          stage: "access",
        });
      }
      const result = await graph.invoke(
        {
          query: input.query,
          tenantId: input.tenantId,
          threadId: input.threadId,
          principal: input.principal,
          confirmationProposalId: input.confirmationProposalId,
          confirmationToken: input.confirmationToken,
          messages: convertMessages(input.history),
          transcriptConfidence: input.transcriptConfidence ?? null,
        },
        config,
      );
      const answer = result.finalAnswer ?? "";
      const chunkSize = 24;
      for (let index = 0; index < answer.length; index += chunkSize) {
        yield answer.slice(index, index + chunkSize);
      }
    },
  };
}

export * from "./type";
export * from "./schema";
export * from "./channels";
export * from "./access";
export * from "./entry-idempotency";
export * from "./prefilter";
export * from "./actions/signal";
export * from "./actions/proposal";
export * from "./mcp/stateless";
export * from "./mcp/confirmation";
export * from "./state";
export * from "./agent";
export * from "./vectorstore";
export * from "./rerank";
