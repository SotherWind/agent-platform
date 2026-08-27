import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AgentState, AgentStateType, State } from "./state";
import { ChartSpec } from "./entities";
import { getSchema } from "./db/sqlite.js";
import {
  generateSqlTool,
  buildDeterministicRetailAggregateSql,
  formatChartTool,
  suggestChartConfigTool,
} from "./tools";
import type { DialectFamily, SqlExecutor } from "./datasource/types.js";
import { createExecutor } from "./datasource/executors/index.js";
import type { ExecutorRegistry } from "./datasource/executor-registry.js";
import { isRetriableFailure } from "./errors/sql-failure.js";
import type { RetrievedSchema } from "./metadata/types.js";
import type { SchemaRetriever } from "./metadata/retriever.js";
import { retrieveRelevantSchema } from "./metadata/retriever.js";
import { assembleSchema } from "./metadata/schema-assembler.js";
import { computeMetadataFreshness } from "./metadata/freshness.js";
import type { RuntimeProfile } from "./config/types.js";
import type { RequestContext } from "./runtime/request-context.js";
import { AppError } from "./errors/app-error.js";
import { createDefaultAccessPolicy } from "./policy/access-policy.js";
import { createRequestContext } from "./runtime/request-context.js";
import { emitAuditEvent } from "./audit/events.js";
import {
  applyResultPolicy,
  extractAggregationCountColumns,
  isAggregationQuery,
} from "./policy/result-policy.js";
import {
  MetricRegistry,
  defaultMetricsDir,
  compileCertifiedMetric,
  inferTimeRangeFromQuery,
  type MetricDefinition,
} from "./semantic/index.js";
import { resolveTimeRangePreset } from "./semantic/calendar.js";
import type { ClarificationRequest } from "./query-plan/clarification.js";
import { parseClarificationChoice } from "./query-plan/clarification-resolver.js";
import type {
  FilterExpression,
  TimeGrain,
} from "./query-plan/logical-query.js";
import { appendFreshnessWarnings } from "./runtime/freshness-answer.js";
import { routeDataSourceAsync } from "./datasource/router.js";
import {
  hasConfiguredLlm,
  suggestChartConfigLocal,
} from "./runtime/local-chart.js";
import { buildChartSpec } from "./tools/echarts_option.js";
import { maybeRecordSlowQuery } from "./runtime/slow-query.js";
import {
  getSessionAsync,
  touchSessionAsync,
  upsertSessionAsync,
} from "./session/store.js";

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

  const principal = {
    subjectId: "local-user",
    tenantId: "local-tenant",
    roles: ["analyst"],
    claims: {},
  };
  return createRequestContext({
    principal,
    policySnapshot: createDefaultAccessPolicy(principal),
    runtimeProfile: profile,
  });
}

function resolveTimeRangeFromChoice(
  presetId: string,
  timezone: string,
): ReturnType<typeof inferTimeRangeFromQuery> {
  return resolveTimeRangePreset(presetId, { timezone });
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

const createDatasourceRouterNode = (
  profile: RuntimeProfile,
): AgentStateType => {
  return async (state, config) => {
    const ctx = resolveRequestContext(config, profile);
    const choice = ctx.clarificationChoice
      ? parseClarificationChoice(ctx.clarificationChoice)
      : undefined;

    if (choice?.kind === "datasource") {
      const authorized = profile.dataSourceRegistry.getAuthorized(
        ctx.principal,
        ctx.policySnapshot,
      );
      const source = authorized.find((s) => s.id === choice.value);
      if (!source) {
        return {
          clarification: {
            reason: "unauthorized_scope" as const,
            question: "所选数据源不在当前授权范围内",
          },
          finalAnswer: "无权访问所选数据源",
          confidence: 0,
        };
      }
      emitAuditEvent({
        event: "datasource.selected",
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        subjectId: ctx.principal.subjectId,
        tenantId: ctx.principal.tenantId,
        dataSourceId: source.id,
        metadata: {
          ok: true,
          confidence: 1,
          clarificationChoice: choice.id,
          scoring: "clarification",
        },
      });
      return {
        dataSourceId: source.id,
        dialectFamily: source.dialectFamily,
        confidence: 1,
        clarification: null,
      };
    }

    let sessionLast: string | undefined;
    if (ctx.sessionId) {
      const session = await getSessionAsync(
        profile.sessionStore,
        ctx.principal.tenantId,
        ctx.principal.subjectId,
        ctx.sessionId,
      );
      sessionLast = session?.lastDataSourceId;
    }

    const routed = await routeDataSourceAsync({
      query: state.analysisQuery,
      principal: ctx.principal,
      policy: ctx.policySnapshot,
      registry: profile.dataSourceRegistry,
      preferredDataSourceId:
        process.env.BI_DEFAULT_DATASOURCE_ID?.trim() || undefined,
      sessionLastDataSourceId: sessionLast,
      isFollowUp: Boolean(sessionLast) && state.analysisQuery.length < 40,
      schemaRetriever: profile.schemaRetriever,
    });

    emitAuditEvent({
      event: "datasource.selected",
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      subjectId: ctx.principal.subjectId,
      tenantId: ctx.principal.tenantId,
      dataSourceId: routed.dataSourceId,
      metadata: {
        ok: routed.ok,
        confidence: routed.confidence,
        candidates: routed.candidates.map((c) => c.id),
        scoring: routed.scoring,
      },
    });

    if (!routed.ok) {
      return {
        clarification: routed.clarification ?? {
          reason: "ambiguous_datasource" as const,
          question: routed.reason ?? "请选择数据源",
        },
        finalAnswer:
          routed.clarification?.question ??
          routed.reason ??
          "请选择数据源",
        confidence: routed.confidence,
      };
    }

    if (ctx.sessionId && routed.dataSourceId) {
      try {
        await touchSessionAsync(
          profile.sessionStore,
          ctx.principal.tenantId,
          ctx.principal.subjectId,
          ctx.sessionId,
          ctx.policySnapshot.policyVersion,
        );
        // 更新 lastDataSourceId
        const existing = await getSessionAsync(
          profile.sessionStore,
          ctx.principal.tenantId,
          ctx.principal.subjectId,
          ctx.sessionId,
        );
        if (existing) {
          await upsertSessionAsync(profile.sessionStore, {
            ...existing,
            lastDataSourceId: routed.dataSourceId,
          });
        }
      } catch {
        // 会话 touch 失败不阻断选源
      }
    }

    return {
      dataSourceId: routed.dataSourceId!,
      dialectFamily: routed.dialectFamily ?? null,
      confidence: routed.confidence,
      clarification: null,
    };
  };
};

/** 指标 / RAG / 澄清 路由 */
const createQueryPathRouterNode = (
  metricRegistry: MetricRegistry,
  profile: RuntimeProfile,
): AgentStateType => {
  return async (state, config) => {
    const ctx = resolveRequestContext(config, profile);
    const choice = ctx.clarificationChoice
      ? parseClarificationChoice(ctx.clarificationChoice)
      : undefined;

    if (choice?.kind === "metric") {
      const metric = metricRegistry.get(choice.value);
      if (!metric || metric.status !== "certified") {
        return {
          clarification: {
            reason: "ambiguous_metric" as const,
            question: `指标「${choice.value}」不可用或未 certification`,
          },
          matchedMetrics: [],
          confidence: 0.3,
          finalAnswer: `指标「${choice.value}」不可用`,
          queryPath: null,
        };
      }
      return {
        matchedMetrics: [metric.metric],
        queryPath: "metric" as const,
        confidence: 0.98,
        clarification: null,
      };
    }

    const matches = metricRegistry.matchByQuery(state.analysisQuery);

    if (matches.length > 1) {
      const clarification: ClarificationRequest = {
        reason: "ambiguous_metric",
        question: "请选择需要分析的指标口径",
        options: matches.map((m) => ({
          id: `metric.${m.metric}`,
          label: m.label,
        })),
      };
      return {
        clarification,
        matchedMetrics: matches.map((m) => m.metric),
        confidence: 0.4,
        finalAnswer: clarification.question,
        queryPath: null,
      };
    }

    if (matches.length === 1) {
      return {
        matchedMetrics: [matches[0]!.metric],
        queryPath: "metric" as const,
        confidence: 0.92,
        clarification: null,
      };
    }

    return {
      matchedMetrics: [],
      queryPath: "rag" as const,
      confidence: 0.7,
      clarification: null,
    };
  };
};

const createMetricResolverNode = (
  metricRegistry: MetricRegistry,
  profile: RuntimeProfile,
): AgentStateType => {
  return async (state, config) => {
    const ctx = resolveRequestContext(config, profile);
    const metricId = state.matchedMetrics[0];
    if (!metricId) {
      return {
        finalAnswer: "未找到可编译的指标",
        clarification: {
          reason: "ambiguous_metric" as const,
          question: "未匹配到 certified 指标，请换一种问法或指定指标",
        },
      };
    }

    const metric = metricRegistry.get(metricId);
    if (!metric || metric.status !== "certified") {
      return {
        finalAnswer: `指标 ${metricId} 不可用（未 certification）`,
      };
    }

    const choice = ctx.clarificationChoice
      ? parseClarificationChoice(ctx.clarificationChoice)
      : undefined;
    const requestedDataSourceId =
      choice?.kind === "datasource"
        ? choice.value
        : state.dataSourceId || metric.datasourceId;
    const sourceConfig = profile.dataSourceRegistry.get(requestedDataSourceId);
    if (
      !sourceConfig ||
      !ctx.policySnapshot.allowedDataSourceIds.includes(requestedDataSourceId)
    ) {
      return {
        finalAnswer: "无权访问该指标对应的数据源",
        clarification: {
          reason: "unauthorized_scope" as const,
          question: "当前身份无权访问该指标所属数据源",
        },
      };
    }

    const dimensions = inferDimensions(state.analysisQuery, metric);
    const timeGrain = inferTimeGrain(state.analysisQuery);
    const filters = inferFilters(state.analysisQuery, metric);
    const inferredRange =
      choice?.kind === "range"
        ? resolveTimeRangeFromChoice(choice.id, metric.timezone)
        : inferTimeRangeFromQuery(state.analysisQuery, {
            timezone: metric.timezone,
          });
    const timeRange = inferredRange
      ? {
          field: metric.timeDimension,
          from: inferredRange.from,
          to: inferredRange.to,
          timezone: inferredRange.timezone,
        }
      : undefined;

    const dialectFamily: DialectFamily =
      sourceConfig?.dialectFamily ?? "sqlite";

    // The certified metric keeps its canonical tables, fields, and join graph.
    // A datasource clarification changes only the runtime source and dialect.
    const runtimeMetric =
      requestedDataSourceId === metric.datasourceId
        ? metric
        : { ...metric, datasourceId: requestedDataSourceId };

    const compiled = compileCertifiedMetric({
      metric: runtimeMetric,
      dimensions,
      filters,
      timeRange,
      timeGrain,
      dialectFamily,
    });

    if (!compiled.ok) {
      // 禁止静默降级到自由 SQL
      emitAuditEvent({
        event: "query.plan_built",
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        subjectId: ctx.principal.subjectId,
        tenantId: ctx.principal.tenantId,
        metadata: {
          metricId,
          ok: false,
          reason: compiled.reason,
          timeGrain,
          timePreset: inferredRange?.preset,
        },
      });
      return {
        queryPath: "metric" as const,
        finalAnswer: compiled.clarification?.question ??
          `指标编译失败: ${compiled.reason}`,
        clarification: compiled.clarification ?? null,
        generatedSql: "",
        logicalQuery: null,
      };
    }

    emitAuditEvent({
      event: "metric.matched",
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      subjectId: ctx.principal.subjectId,
      tenantId: ctx.principal.tenantId,
      dataSourceId: requestedDataSourceId,
      metadata: {
        metricId,
        dimensions,
        timeGrain,
        timePreset: inferredRange?.preset,
        dialectFamily,
      },
    });
    emitAuditEvent({
      event: "sql.generated",
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      subjectId: ctx.principal.subjectId,
      tenantId: ctx.principal.tenantId,
      dataSourceId: requestedDataSourceId,
      metadata: { path: "metric", dialectFamily, timeGrain },
    });

    return {
      queryPath: "metric" as const,
      dataSourceId: requestedDataSourceId,
      dialectFamily,
      generatedSql: compiled.sql!,
      sqlParams: compiled.params ?? [],
      logicalQuery: compiled.logicalQuery ?? null,
      clarification: null,
      dataFreshness: {
        dataAsOf: new Date().toISOString(),
        timezone: metric.timezone,
        status: "fresh" as const,
        warnings: [],
      },
    };
  };
};

function inferDimensions(query: string, metric: MetricDefinition): string[] {
  const dims: string[] = [];
  const q = query.toLowerCase();
  for (const dim of metric.dimensions) {
    if (
      q.includes(dim.name.toLowerCase()) ||
      (dim.name === "user_name" && /用户|客户|姓名|user\s*name/i.test(query)) ||
      (dim.name === "city" && /城市|city|北京|上海|广州|深圳|杭州/.test(query)) ||
      (dim.name === "status" && /状态|status/i.test(query))
    ) {
      dims.push(dim.name);
    }
  }
  // 订单总额按城市 —— 若问到城市相关且指标有 city 维度
  if (
    dims.length === 0 &&
    /城市|按城|各城|city/.test(query) &&
    metric.dimensions.some((d) => d.name === "city")
  ) {
    dims.push("city");
  }
  return dims;
}

/** Infer an explicit grouping grain only when the user asks for a trend/bucket. */
export function inferTimeGrain(query: string): TimeGrain | undefined {
  const q = query.toLowerCase();
  const explicit: Array<{ grain: TimeGrain; pattern: RegExp }> = [
    {
      grain: "quarter",
      pattern: /按\s*(?:每)?季度|每季度|逐季度|季度|quarterly|by\s+quarter/i,
    },
    {
      grain: "month",
      pattern: /按\s*(?:每)?月|每月|逐月|月度|月份|monthly|by\s+month|month\s+over\s+month/i,
    },
    {
      grain: "week",
      pattern: /按\s*(?:每)?周|每周|逐周|周度|星期|weekly|by\s+week/i,
    },
    {
      grain: "day",
      pattern: /按\s*(?:每)?[天日]|每天|每日|逐日|日度|daily|by\s+day/i,
    },
    {
      grain: "year",
      pattern: /按\s*(?:每)?年|每年|逐年|年度|yearly|by\s+year/i,
    },
  ];
  for (const candidate of explicit) {
    if (candidate.pattern.test(q)) return candidate.grain;
  }

  // “最近三个月趋势”没有“按月”字样，但仍明确要求时间序列。
  if (/趋势|走势|trend|over\s+time/i.test(q)) {
    if (/季度|quarter/i.test(q)) return "quarter";
    if (/月|month/i.test(q)) return "month";
    if (/周|星期|week/i.test(q)) return "week";
    if (/天|日|day/i.test(q)) return "day";
    if (/年|year/i.test(q)) return "year";
  }

  return undefined;
}

function inferFilters(
  query: string,
  metric: MetricDefinition,
): FilterExpression[] {
  const filters: FilterExpression[] = [];
  const cityMatch = inferCityValue(query);
  if (cityMatch && metric.dimensions.some((d) => d.name === "city")) {
    const cityDim = metric.dimensions.find((d) => d.name === "city")!;
    filters.push({
      field: `${cityDim.table}.${cityDim.column}`,
      operator: "=",
      value: cityMatch,
    });
  }

  const nameDim = metric.dimensions.find(
    (dim) => dim.name === "user_name" || (dim.table === "users" && dim.column === "name"),
  );
  const entityName = inferEntityName(query);
  if (nameDim && entityName) {
    filters.push({
      field: `${nameDim.table}.${nameDim.column}`,
      operator: "=",
      value: entityName,
    });
  }

  return filters;
}

/** Capture both known cities and arbitrary values such as "火星城市". */
function inferCityValue(query: string): string | undefined {
  const explicit = query.match(
    /(?:城市|city)\s*(?:为|是|=|:|：)\s*[「『“"']?([\p{Script=Han}A-Za-z0-9_-]{1,40})/iu,
  )?.[1];
  if (explicit) return explicit;

  const beforeCity = query.match(
    /(?:查询|查|统计|筛选|过滤|来自|在)\s*([\p{Script=Han}A-Za-z0-9_-]{1,40})\s*(?:城市|city)/iu,
  )?.[1];
  if (
    beforeCity &&
    !new Set(["各", "各个", "每个", "每一", "所有", "任意", "不同"]).has(
      beforeCity,
    )
  ) {
    return beforeCity;
  }

  return query.match(/(北京|上海|广州|深圳|杭州|武汉|西安)/)?.[1];
}

const ENTITY_NAME_STOPWORDS = new Set([
  "本月",
  "本月的",
  "这个月",
  "这个月的",
  "上个月",
  "上个月的",
  "北京",
  "上海",
  "广州",
  "深圳",
  "杭州",
  "武汉",
  "西安",
  "用户",
  "客户",
  "城市",
]);

export function inferEntityName(query: string): string | undefined {
  const cleaned = query
    .trim()
    .replace(/^(?:请)?(?:(?:帮我|给我)?)(?:查询|查|统计|查看)(?:一下)?/u, "")
    .replace(/^(?:用户|客户|销售人员|销售员)/u, "");
  const suffix =
    "(?:(?:这个月|本月|上个月)(?:的)?|的)?(?:销售额|营销额|订单总额|成交总额|流水)";

  const englishSuffix =
    "(?:(?:(?:this|last)\\s+month)\\s+)?(?:sales(?:\\s+amount)?|marketing(?:\\s+amount)?|revenue|income|total\\s+sales|gmv)|(?:sales(?:\\s+amount)?|marketing(?:\\s+amount)?|revenue|income|total\\s+sales|gmv)\\s+(?:this|last)\\s+month";
  const latin = cleaned.match(
    new RegExp(
      `\\b([A-Z][A-Za-z]{1,40})\\b(?=\\s*(?:${suffix}|${englishSuffix}))`,
      "i",
    ),
  )?.[1];
  if (latin && !isEntityNameStopword(latin)) return latin;

  const chineseCandidates = cleaned.matchAll(
    new RegExp(`([\\p{Script=Han}]{2,4})(?=${suffix})`, "gu"),
  );
  for (const match of chineseCandidates) {
    const chinese = match[1];
    if (chinese && !isEntityNameStopword(chinese)) return chinese;
  }
  return undefined;
}

function isEntityNameStopword(value: string): boolean {
  return (
    ENTITY_NAME_STOPWORDS.has(value) ||
    value.includes("用户") ||
    value.includes("客户") ||
    value.includes("城市")
  );
}

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

    // 指标路径已生成 SQL，跳过 LLM
    if (state.queryPath === "metric" && state.generatedSql) {
      return {};
    }

    const schema = schemaForSqlGenerator(state, db);
    const dialect = state.dialectFamily ?? "sqlite";

    if (!error) {
      const deterministicSql = buildDeterministicRetailAggregateSql(
        analysisQuery,
        schema,
      );
      if (deterministicSql) {
        return {
          generatedSql: deterministicSql,
          deterministicSql: true,
          sqlParams: [],
        };
      }
    }

    let query = analysisQuery;
    if (error) {
      // Keep the retry prompt compact and stable; `error` is already sanitized by the executor.
      query = `${analysisQuery} (fix error: ${error})`;
      if (failureKind) {
        console.warn(
          `[bi-analyst] 上次 SQL 执行失败 (${failureKind})，携带脱敏错误上下文重新生成: ${error}`,
        );
      }
    }

    const sql = await generateSqlTool.invoke({
      query,
      schema,
      dialect,
    });

    return { generatedSql: sql, deterministicSql: false, sqlParams: [] };
  };
};

const createCodeInterpreterNode = (
  defaultExecutor: SqlExecutor,
  profile: RuntimeProfile,
  executorRegistry?: ExecutorRegistry,
) => {
  return async (state: State, config?: RunnableConfig) => {
    // 澄清提前结束，不应执行
    if (state.clarification && !state.generatedSql) {
      return {};
    }

    const ctx = resolveRequestContext(config, profile);
    const { generatedSql, dataSourceId, sqlParams } = state;
    if (!generatedSql) {
      return {
        executionResult: {
          columns: [],
          rows: [],
          rowCount: 0,
          isEmpty: true,
          error: "缺少可执行 SQL",
          failureKind: "unknown" as const,
        },
      };
    }

    const resolvedId =
      dataSourceId ||
      ctx.policySnapshot.allowedDataSourceIds[0] ||
      "ecommerce_sqlite";

    let executor = defaultExecutor;
    if (executorRegistry) {
      const routed = executorRegistry.tryResolve(resolvedId);
      if (!routed) {
        return {
          executionResult: {
            columns: [],
            rows: [],
            rowCount: 0,
            isEmpty: true,
            error: `数据源 ${resolvedId} 未注册执行器`,
            failureKind: "connection_error" as const,
          },
        };
      }
      executor = routed;
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (ctx.abortSignal.aborted) {
      controller.abort();
    } else {
      ctx.abortSignal.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeoutMs = Math.min(5_000, Math.max(1, ctx.deadlineAt - Date.now()));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const raw = await executor.execute(
        {
          sql: generatedSql,
          dataSourceId: resolvedId,
          tenantId: ctx.principal.tenantId,
          subjectId: ctx.principal.subjectId,
          sessionId: ctx.sessionId,
          requestId: ctx.requestId,
          timeoutMs,
          allowedTables: ctx.policySnapshot.allowedTables,
          allowedColumns: ctx.policySnapshot.allowedColumns,
          deniedColumns: ctx.policySnapshot.deniedColumns,
          rowFilters: ctx.policySnapshot.rowFilters,
          // 直接传参，避免 LangChain tool schema 丢弃 sqlParams
          params: sqlParams?.length ? [...sqlParams] : undefined,
        },
        controller.signal,
      );

      const result = applyResultPolicy(raw, {
        accessPolicy: ctx.policySnapshot,
        options: {
          minAggregationCount: ctx.policySnapshot.minAggregationCount,
          aggregationCountColumns: extractAggregationCountColumns(generatedSql),
          enforceAggregationCount:
            ctx.policySnapshot.minAggregationCount !== undefined &&
            isAggregationQuery(generatedSql),
        },
      });
      const durationMs =
        result.stats?.durationMs ?? Date.now() - started;

      emitAuditEvent({
        event: result.error ? "sql.validation_rejected" : "sql.executed",
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        subjectId: ctx.principal.subjectId,
        tenantId: ctx.principal.tenantId,
        dataSourceId: resolvedId,
        failureKind: result.failureKind,
        rowCount: result.rows?.length,
        durationMs,
        metadata: {
          rowCount: result.rows?.length,
          isEmpty: result.isEmpty,
          paramCount: sqlParams?.length ?? 0,
        },
      });

      maybeRecordSlowQuery(profile.productization?.slowQueryRecorder, {
        id: `slow-${ctx.requestId}`,
        tenantId: ctx.principal.tenantId,
        subjectId: ctx.principal.subjectId,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        dataSourceId: resolvedId,
        durationMs,
        rowCount: result.rows?.length,
        failureKind: result.failureKind,
        sqlPreview: generatedSql.slice(0, 500),
        createdAt: new Date().toISOString(),
      });

      return { executionResult: result };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener("abort", forwardAbort);
    }
  };
};

const emptyTableChart = (title: string): ChartSpec => ({
  type: "table",
  title,
  dataset: { columns: [], rows: [] },
});

const chartFormatterNode: AgentStateType = async (state) => {
  const {
    analysisQuery,
    executionResult,
    dataFreshness,
    clarification,
    queryPath,
  } = state;

  if (clarification && !executionResult) {
    return {
      finalAnswer: appendFreshnessWarnings(
        clarification.question,
        dataFreshness,
      ),
    };
  }

  if (!executionResult) {
    return {
      finalAnswer: appendFreshnessWarnings(
        "No execution result.",
        dataFreshness,
      ),
    };
  }

  if (executionResult.error) {
    console.error(
      `[bi-analyst] SQL 执行失败，已达最大重试次数: ${executionResult.error}`,
    );
    return {
      finalAnswer: appendFreshnessWarnings(
        `Execution error: ${executionResult.error}`,
        dataFreshness,
      ),
    };
  }

  if (executionResult.isEmpty) {
    return {
      finalAnswer: appendFreshnessWarnings(
        "Query returned no data.",
        dataFreshness,
      ),
      chartSpec: emptyTableChart("Empty Result"),
    };
  }

  try {
    // Certified metrics already have stable semantics and a known result shape;
    // keep their presentation deterministic so an optional chart-model timeout
    // cannot turn a successful query into a failed request.
    const useLlmChart =
      hasConfiguredLlm() && queryPath !== "metric" && !state.deterministicSql;
    const chartConfig = useLlmChart
      ? await suggestChartConfigTool.invoke({
          query: analysisQuery,
          data: executionResult,
        })
      : suggestChartConfigLocal(analysisQuery, executionResult);

    const chart = useLlmChart
      ? await formatChartTool.invoke({
          data: executionResult,
          chartType: chartConfig.chartType,
          title: chartConfig.title,
        })
      : buildChartSpec(
          chartConfig.chartType,
          chartConfig.title,
          executionResult,
        );

    return {
      chartSpec: chart,
      finalAnswer: appendFreshnessWarnings(
        chartConfig.explanation,
        dataFreshness,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = suggestChartConfigLocal(analysisQuery, executionResult);
    return {
      chartSpec: buildChartSpec(
        fallback.chartType,
        fallback.title,
        executionResult,
      ),
      finalAnswer: appendFreshnessWarnings(
        `${fallback.explanation}\n（图表推荐降级：${message}）`,
        dataFreshness,
      ),
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
  const { retryCount, executionResult, queryPath } = state;
  const { error, failureKind } = executionResult || {};

  // 指标路径不自愈（保持确定性口径）
  if (queryPath === "metric") {
    return "chartFormatter";
  }

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

function routeAfterDatasource(state: State): string {
  if (state.clarification) return "clarify";
  return "queryPathRouter";
}

function routeAfterPlanner(state: State): string {
  if (state.clarification) return "clarify";
  if (state.queryPath === "metric") return "metricResolver";
  return "schemaRag";
}

function routeAfterMetric(state: State): string {
  if (state.clarification || !state.generatedSql) return "clarify";
  return "codeInterpreter";
}

export interface BuildGraphConfig {
  checkpointer?: BaseCheckpointSaver;
  db?: unknown | null;
  executor?: SqlExecutor;
  /** 按 dataSourceId 选执行器；优先于单一 executor */
  executorRegistry?: ExecutorRegistry;
  schemaRetriever?: SchemaRetriever;
  runtimeProfile: RuntimeProfile;
  metricRegistry?: MetricRegistry;
  /** 启用 Schema RAG；默认 true */
  useSchemaRag?: boolean;
  maxRetryCount?: number;
}

export const buildGraph = (configs: BuildGraphConfig) => {
  const { checkpointer, db, runtimeProfile } = configs;
  const executorRegistry =
    configs.executorRegistry ?? runtimeProfile.executorRegistry;
  const executor =
    configs.executor ??
    (db != null
      ? createExecutor({ db: db as never })
      : ({
          async execute() {
            throw new Error(
              "缺少默认 SqlExecutor：请配置 db 或 executorRegistry",
            );
          },
          async healthCheck() {
            return { healthy: false, message: "no default executor" };
          },
          async close() {},
        } as SqlExecutor));
  const useSchemaRag = configs.useSchemaRag !== false;
  const schemaRetriever =
    configs.schemaRetriever ?? runtimeProfile.schemaRetriever;
  const maxRetryCount =
    configs.maxRetryCount ?? Number(process.env.MAX_RETRY_COUNT ?? 3);
  const metricRegistry =
    configs.metricRegistry ??
    MetricRegistry.fromDirectory(defaultMetricsDir());

  const codeInterpreterNode = createCodeInterpreterNode(
    executor,
    runtimeProfile,
    executorRegistry,
  );
  const sqlGeneratorNode = createSqlGeneratorNode(db);
  const schemaRagNode = createSchemaRagNode(schemaRetriever, runtimeProfile);
  const retryNode = createRetryNode(maxRetryCount);
  const datasourceRouterNode = createDatasourceRouterNode(runtimeProfile);
  const queryPathRouterNode = createQueryPathRouterNode(metricRegistry, runtimeProfile);
  const metricResolverNode = createMetricResolverNode(
    metricRegistry,
    runtimeProfile,
  );
  const clarifyNode: AgentStateType = async (state) => ({
    finalAnswer:
      state.clarification?.question ??
      state.finalAnswer ??
      "需要更多信息才能继续分析",
  });

  const workflow = new StateGraph(AgentState)
    .addNode("planner", plannerNode)
    .addNode("datasourceRouter", datasourceRouterNode)
    .addNode("queryPathRouter", queryPathRouterNode)
    .addNode("metricResolver", metricResolverNode)
    .addNode("clarify", clarifyNode)
    .addNode("schemaRag", schemaRagNode)
    .addNode("sqlGenerator", sqlGeneratorNode)
    .addNode("codeInterpreter", codeInterpreterNode)
    .addNode("chartFormatter", chartFormatterNode)
    .addNode("retry", retryNode)
    .addEdge(START, "planner")
    .addEdge("planner", "datasourceRouter")
    .addConditionalEdges("datasourceRouter", routeAfterDatasource)
    .addConditionalEdges("queryPathRouter", routeAfterPlanner)
    .addConditionalEdges("metricResolver", routeAfterMetric)
    .addEdge("clarify", END);

  if (useSchemaRag) {
    workflow
      .addEdge("schemaRag", "sqlGenerator")
      .addEdge("sqlGenerator", "codeInterpreter");
  } else {
    workflow.addEdge("schemaRag", "sqlGenerator");
    workflow.addEdge("sqlGenerator", "codeInterpreter");
  }

  workflow
    .addConditionalEdges("codeInterpreter", (state) =>
      shouldRetry(state, maxRetryCount),
    )
    .addEdge("retry", "sqlGenerator")
    .addEdge("chartFormatter", END);

  return workflow.compile({
    checkpointer: checkpointer ?? runtimeProfile.checkpointer,
  });
};
