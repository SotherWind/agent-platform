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



export const AgentState = new StateSchema({

  messages: MessagesValue,

  analysisQuery: z.string().default(""),

  generatedSql: z.string().default(""),

  executionResult: ExecutionResultSchema.nullable().default(null),

  chartSpec: ChartSpecSchema.nullable().default(null),

  retryCount: new ReducedValue(z.number().default(0), {

    reducer: (curr, next) => curr + next,

  }),

  finalAnswer: z.string(),

  // Phase 0+ 业务状态（可信身份/权限由 RequestContext 注入，不进入 AgentState）

  dataSourceId: z.string().default(""),

  dialectFamily: z.custom<DialectFamily>().nullable().default(null),

  domain: z.string().default(""),

  queryPath: z.enum(["metric", "rag"]).nullable().default(null),

  matchedMetrics: z.array(z.string()).default([]),

  retrievedSchema: z.custom<RetrievedSchema>().nullable().default(null),

  clarification: z.string().nullable().default(null),

  confidence: z.number().nullable().default(null),

  dataFreshness: z.custom<DataFreshnessMeta>().nullable().default(null),

});



export type AgentStateType = GraphNode<typeof AgentState>;

export type State = typeof AgentState.State;

