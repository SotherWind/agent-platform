import {
  StateSchema,
  MessagesValue,
  ReducedValue,
  GraphNode,
} from "@langchain/langgraph";
import { z } from "zod";
import { ExecutionResultSchema, ChartSpecSchema } from "./entities";
import type { RetrievedSchema } from "./metadata/types.js";
import type { DataFreshnessMeta } from "./metadata/freshness.js";
import type { DialectFamily } from "./datasource/types.js";
import type { LogicalQuery } from "./query-plan/logical-query.js";
import type { ClarificationRequest } from "./query-plan/clarification.js";

export const AgentState = new StateSchema({
  messages: MessagesValue,
  analysisQuery: z.string().default(""),
  generatedSql: z.string().default(""),
  deterministicSql: z.boolean().default(false),
  sqlParams: z.array(z.union([z.string(), z.number()])).default([]),
  executionResult: ExecutionResultSchema.nullable().default(null),
  chartSpec: ChartSpecSchema.nullable().default(null),
  retryCount: new ReducedValue(z.number().default(0), {
    reducer: (curr, next) => curr + next,
  }),
  finalAnswer: z.string(),
  dataSourceId: z.string().default(""),
  dialectFamily: z.custom<DialectFamily>().nullable().default(null),
  domain: z.string().default(""),
  queryPath: z.enum(["metric", "rag"]).nullable().default(null),
  matchedMetrics: z.array(z.string()).default([]),
  retrievedSchema: z.custom<RetrievedSchema>().nullable().default(null),
  logicalQuery: z.custom<LogicalQuery>().nullable().default(null),
  clarification: z.custom<ClarificationRequest>().nullable().default(null),
  confidence: z.number().nullable().default(null),
  dataFreshness: z.custom<DataFreshnessMeta>().nullable().default(null),
});

export type AgentStateType = GraphNode<typeof AgentState>;
export type State = typeof AgentState.State;
