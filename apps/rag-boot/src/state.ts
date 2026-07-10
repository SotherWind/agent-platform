import { StateSchema, MessagesValue, GraphNode } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  AnswerCitationSchema,
  RerankedChunkSchema,
  RetrievedChunkSchema,
} from "./schema";

export const AgentState = new StateSchema({
  messages: MessagesValue,
  tenantId: z
    .string()
    .default("")
    .describe("租户标识，用于隔离知识库检索与引用范围"),
  query: z
    .string()
    .default("")
    .describe("用户问题或检索意图，驱动向量检索与重排序"),
  retrievedDocs: z
    .array(RetrievedChunkSchema)
    .default(() => [])
    .describe("向量相似度检索返回的 chunk 候选集"),
  rerankedDocs: z
    .array(RerankedChunkSchema)
    .default(() => [])
    .describe("经重排序筛选后的相关 chunk，作为生成上下文"),
  finalAnswer: z.string().default("").describe("基于检索上下文生成的最终回答"),
  citations: z
    .array(AnswerCitationSchema)
    .default(() => [])
    .describe("回答引用的原文片段与来源，用于溯源展示"),
});

export type AgentGraphNode = GraphNode<typeof AgentState>;

export type State = typeof AgentState.State;
