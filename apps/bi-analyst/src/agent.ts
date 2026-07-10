import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState, AgentStateType, State } from "./state";
import { ChartSpec } from "./entities";
import { getSchema } from "./db/seed";
import {
  generateSqlTool,
  createExecuteCodeTool,
  formatChartTool,
  suggestChartConfigTool,
} from "./tools";
import type { SqlExecutor } from "./datasource/types.js";
import { createExecutor } from "./datasource/executors/index.js";
import { isRetriableFailure } from "./errors/sql-failure.js";
import type { RetrievedSchema } from "./metadata/types.js";
import type { SchemaRetriever } from "./metadata/retriever.js";
import { retrieveRelevantSchema } from "./metadata/retriever.js";
import { assembleSchema } from "./metadata/schema-assembler.js";
import { computeMetadataFreshness } from "./metadata/freshness.js";
import type { RuntimeProfile } from "./config/types.js";
import type { RequestContext } from "./runtime/request-context.js";
import { createLocalFallbackRequestContext } from "./runtime/local-fallback.js";
import { AppError } from "./errors/app-error.js";
import { emitAuditEvent } from "./audit/events.js";

export type BiAnalystGraph = ReturnType<typeof buildGraph>;

function resolveRequestContext(
  config: RunnableConfig | undefined,
  profile: RuntimeProfile,
): RequestContext {
  const ctx = config?.configurable?.requestContext as RequestContext | undefined;
  if (ctx) {
    return ctx;
  }

  if (!profile.isLocal) {
    throw new AppError(
      "生产环境必须通过 RequestContext 注入可信身份与权限",
      "missing_request_context",
      500,
      false,
    );
  }

  return createLocalFallbackRequestContext(profile);
}

const plannerNode: AgentStateType = async (state) => {
  const { messages } = state;
  const lastMessage = messages.at(-1);
  const query =
    typeof lastMessage?.content === "string"
      ? lastMessage.content
      : "analyze data";
  return { analysisQuery: query };
};

const createSchemaRagNode = (
  retriever: SchemaRetriever,
  profile: RuntimeProfile,
): AgentStateType => {
  return async (state, config) => {
    const ctx = resolveRequestContext(config, profile);
    const { analysisQuery, dataSourceId } = state;

    const retrieved = await retrieveRelevantSchema(
      retriever,
      analysisQuery,
      ctx.policySnapshot,
      dataSourceId || undefined,
    );

    const assembled = assembleSchema({
      datasourceId: retrieved.datasourceId,
      dialectFamily: retrieved.dialectFamily,
      documents: retrieved.documents,
      policy: ctx.policySnapshot,
    });

    emitAuditEvent({
      event: "metadata.retrieved",
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      subjectId: ctx.principal.subjectId,
      tenantId: ctx.principal.tenantId,
      dataSourceId: retrieved.datasourceId,
      metadata: {
        documentCount: retrieved.documents.length,
        tableCount: assembled.tables.length,
      },
    });

    return {
      dataSourceId: retrieved.datasourceId,
      dialectFamily: retrieved.dialectFamily,
      domain: retrieved.domain,
      retrievedSchema: assembled,
      queryPath: "rag" as const,
      dataFreshness: computeMetadataFreshness(retrieved.documents),
    };
  };
};

function schemaForSqlGenerator(
  state: State,
  db: unknown,
): RetrievedSchema | ReturnType<typeof getSchema> {
  if (state.retrievedSchema) {
    return state.retrievedSchema;
  }
  return getSchema(db as never);
}

const createSqlGeneratorNode = (db: unknown): AgentStateType => {
  return async (state) => {
    const { analysisQuery, executionResult } = state;
    const { error, failureKind } = executionResult || {};

    const query = error
      ? `${analysisQuery} (fix error: ${error})`
      : analysisQuery;

    if (error) {
      console.warn(
        `[bi-analyst] 上次 SQL 执行失败 (${failureKind ?? "unknown"})，携带脱敏错误上下文重新生成: ${error}`,
      );
    }

    const schema = schemaForSqlGenerator(state, db);
    const dialect = state.dialectFamily ?? "sqlite";

    const sql = await generateSqlTool.invoke({
      query,
      schema,
      dialect,
    });

    return { generatedSql: sql };
  };
};

const createCodeInterpreterNode = (
  executor: SqlExecutor,
  profile: RuntimeProfile,
) => {
  return async (state: State, config?: RunnableConfig) => {
    const ctx = resolveRequestContext(config, profile);
    const executeCodeTool = createExecuteCodeTool(executor, {
      accessPolicy: ctx.policySnapshot,
    });

    const { generatedSql, dataSourceId } = state;

    const result = await executeCodeTool.invoke({
      sql: generatedSql,
      executionContext: {
        dataSourceId: dataSourceId || ctx.policySnapshot.allowedDataSourceIds[0] || "default",
        tenantId: ctx.principal.tenantId,
        subjectId: ctx.principal.subjectId,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        timeoutMs: Math.min(5000, ctx.deadlineAt - Date.now()),
      },
      expectedFormat: "chart-ready",
    });

    emitAuditEvent({
      event: result.error ? "sql.validation_rejected" : "sql.executed",
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      subjectId: ctx.principal.subjectId,
      tenantId: ctx.principal.tenantId,
      dataSourceId: dataSourceId || undefined,
      failureKind: result.failureKind,
      metadata: {
        rowCount: result.rows?.length,
        isEmpty: result.isEmpty,
      },
    });

    return { executionResult: result };
  };
};

const emptyTableChart = (title: string): ChartSpec => ({
  type: "table",
  title,
  dataset: { columns: [], rows: [] },
});

const chartFormatterNode: AgentStateType = async (state) => {
  const { analysisQuery, executionResult } = state;

  if (!executionResult) {
    return { finalAnswer: "No execution result." };
  }

  if (executionResult.error) {
    console.error(
      `[bi-analyst] SQL 执行失败，已达最大重试次数: ${executionResult.error}`,
    );
    return { finalAnswer: `Execution error: ${executionResult.error}` };
  }

  if (executionResult.isEmpty) {
    return {
      finalAnswer: "Query returned no data.",
      chartSpec: emptyTableChart("Empty Result"),
    };
  }

  try {
    const chartConfig = await suggestChartConfigTool.invoke({
      query: analysisQuery,
      data: executionResult,
    });

    const chart = await formatChartTool.invoke({
      data: executionResult,
      chartType: chartConfig.chartType,
      title: chartConfig.title,
    });

    return {
      chartSpec: chart,
      finalAnswer: chartConfig.explanation,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      finalAnswer: `Formatting failed: ${message}. Degrading to table format.`,
      chartSpec: emptyTableChart("Raw Data Fallback"),
    };
  }
};

const createRetryNode = (maxRetryCount: number): AgentStateType => {
  return async (state) => {
    const { executionResult, generatedSql, retryCount } = state;
    const error = executionResult?.error;

    if (error) {
      console.warn(
        `[bi-analyst] SQL 执行失败，触发重试 (${retryCount + 1}/${maxRetryCount}): ${error}`,
      );
      if (generatedSql) {
        console.warn(`[bi-analyst] 失败 SQL:\n${generatedSql}`);
      }
    }

    return { retryCount: 1 };
  };
};

export const shouldRetry = (state: State, maxRetryCount?: number) => {
  const limit = maxRetryCount ?? Number(process.env.MAX_RETRY_COUNT ?? 3);
  const { retryCount, executionResult } = state;
  const { error, failureKind } = executionResult || {};

  if (error) {
    const retriable =
      failureKind !== undefined
        ? isRetriableFailure(failureKind)
        : /syntax|no such column|no such table/i.test(error);

    if (!retriable) {
      return "chartFormatter";
    }

    return retryCount < limit ? "retry" : "chartFormatter";
  }

  return "chartFormatter";
};

export interface BuildGraphConfig {
  checkpointer?: BaseCheckpointSaver;
  db: unknown;
  executor?: SqlExecutor;
  schemaRetriever?: SchemaRetriever;
  runtimeProfile: RuntimeProfile;
  /** 启用 Schema RAG；默认 true */
  useSchemaRag?: boolean;
  maxRetryCount?: number;
}

export const buildGraph = (configs: BuildGraphConfig) => {
  const { checkpointer, db, runtimeProfile } = configs;
  const executor = configs.executor ?? createExecutor({ db: db as never });
  const useSchemaRag = configs.useSchemaRag !== false;
  const schemaRetriever =
    configs.schemaRetriever ?? runtimeProfile.schemaRetriever;
  const maxRetryCount =
    configs.maxRetryCount ?? Number(process.env.MAX_RETRY_COUNT ?? 3);

  const codeInterpreterNode = createCodeInterpreterNode(executor, runtimeProfile);
  const sqlGeneratorNode = createSqlGeneratorNode(db);
  const schemaRagNode = createSchemaRagNode(schemaRetriever, runtimeProfile);
  const retryNode = createRetryNode(maxRetryCount);

  const workflow = new StateGraph(AgentState)
    .addNode("planner", plannerNode)
    .addNode("schemaRag", schemaRagNode)
    .addNode("sqlGenerator", sqlGeneratorNode)
    .addNode("codeInterpreter", codeInterpreterNode)
    .addNode("chartFormatter", chartFormatterNode)
    .addNode("retry", retryNode)
    .addEdge(START, "planner");

  if (useSchemaRag) {
    workflow
      .addEdge("planner", "schemaRag")
      .addEdge("schemaRag", "sqlGenerator");
  } else {
    workflow.addEdge("planner", "sqlGenerator");
  }

  workflow
    .addEdge("sqlGenerator", "codeInterpreter")
    .addConditionalEdges("codeInterpreter", (state) =>
      shouldRetry(state, maxRetryCount),
    )
    .addEdge("retry", "sqlGenerator")
    .addEdge("chartFormatter", END);

  return workflow.compile({
    checkpointer: checkpointer ?? runtimeProfile.checkpointer,
  });
};
