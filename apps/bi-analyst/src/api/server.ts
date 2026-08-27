import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import type { BootstrapResult } from "../bootstrap/runtime-common.js";
import { parseAnalyzeRequest, AuthError, buildSessionKey } from "../auth/principal.js";
import { createRequestContext } from "../runtime/request-context.js";
import { emitAuditEvent, setAuditEmitter } from "../audit/events.js";
import { setAuditLogger } from "../audit/logger.js";
import { AppError, toClientError } from "../errors/app-error.js";
import { loadPolicyForPrincipalAsync } from "../policy/load-policy.js";
import type { RequestContext } from "../runtime/request-context.js";
import { buildGraph, type BiAnalystGraph } from "../agent.js";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import { PermissionAwareQueryCache } from "../cache/query-cache.js";
import type { QueryCacheKeyParts } from "../cache/query-cache.js";
import { hashLogicalQuery } from "../cache/logical-query-hash.js";
import type { LogicalQuery } from "../query-plan/logical-query.js";
import { MetricRegistry, defaultMetricsDir } from "../semantic/index.js";
import { InMemoryQueryHistoryStore } from "../history/store.js";
import { TenantRateLimiter } from "../runtime/rate-limit.js";
import {
  approveExportJobAsync,
  createExportJobAsync,
  getExportJobAsync,
  InMemoryExportJobStore,
  rejectExportJobAsync,
  takeExportDownloadAsync,
} from "../export/csv.js";
import { createDefaultModelRegistry } from "../governance/model-registry.js";
import { createDefaultSloMonitor } from "../runtime/slo.js";
import { redactAuditEvents } from "../audit/store.js";
import {
  decideMetadataReviewAsync,
  InMemoryMetadataReviewStore,
  listMetadataReviewsAsync,
  upsertMetadataDraftAsync,
} from "../metadata/review.js";
import {
  getStagingMockAuth,
  isStagingMockAuthEnabled,
} from "../auth/staging-mock-auth.js";
import {
  generateDraftDescription,
  assertNoAutoCertification,
} from "../metadata/describe.js";
import { diffSchemaDocuments, planIncrementalSync } from "../metadata/sync.js";
import { runMetadataSync } from "../metadata/sync-runner.js";
import type { ProductizationServices } from "../config/types.js";
import type { SchemaDocument } from "../metadata/types.js";
import { registerOrValidateSessionAsync } from "../session/store.js";
import {
  createFeedbackAsync,
  InMemoryAnalysisFeedbackStore,
  listFeedbackAsync,
  listTenantFeedbackAsync,
} from "../governance/feedback.js";
import { buildFeedbackReplayCases } from "../governance/feedback-eval.js";
import {
  AnalysisJobRunner,
  InMemoryAnalysisJobStore,
} from "../runtime/analysis-jobs.js";
import { createDefaultTelemetry, parseTraceParent } from "../runtime/telemetry.js";

export interface AnalyzeResponseBody {
  finalAnswer: string;
  chartSpec?: unknown;
  meta: {
    queryPath: string | null;
    confidence: number | null;
    requestId: string;
    traceId: string;
    cacheHit?: boolean;
    modelVersionId?: string;
    dataFreshness?: {
      dataAsOf: string;
      timezone: string;
      status: "fresh" | "stale" | "unknown";
      warnings: string[];
    };
    resultPolicy?: {
      degraded: boolean;
      warnings: string[];
      reasons: string[];
      returnedRows: number;
      returnedColumns: number;
    };
  };
  needsClarification?: boolean;
  clarification?: unknown;
}

type AnalyzeExecutionSnapshot = {
  columns?: string[];
  rows?: Record<string, unknown>[];
};

type AnalyzeCacheEntry = {
  response: AnalyzeResponseBody;
  executionResult?: AnalyzeExecutionSnapshot;
  dataSourceId?: string;
};

function isAnalyzeCacheEntry(value: unknown): value is AnalyzeCacheEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "response" in value &&
    typeof (value as { response?: unknown }).response === "object"
  );
}

function snapshotExecutionResult(
  result: Record<string, unknown>,
): AnalyzeExecutionSnapshot | undefined {
  const execution = result.executionResult as
    | { columns?: unknown; rows?: unknown }
    | null
    | undefined;
  if (!execution || !Array.isArray(execution.columns) || !Array.isArray(execution.rows)) {
    return undefined;
  }
  return {
    columns: execution.columns.filter((column): column is string => typeof column === "string"),
    rows: execution.rows.slice(0, 5_000) as Record<string, unknown>[],
  };
}

function toAnalyzeCacheEntry(
  response: AnalyzeResponseBody,
  result: Record<string, unknown>,
): AnalyzeCacheEntry {
  return {
    response,
    executionResult: snapshotExecutionResult(result),
    dataSourceId: (result.dataSourceId as string) || undefined,
  };
}

export interface AppServer {
  server: ReturnType<typeof createServer>;
  graph: BiAnalystGraph;
  profile: BootstrapResult["profile"];
  services: ProductizationServices;
  close(): Promise<void>;
}

function readJsonBody(
  req: IncomingMessage,
  options: { maxBytes: number; timeoutMs: number },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const contentLength = Number(req.headers["content-length"] ?? 0);
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > options.maxBytes) {
        req.resume();
        fail(new AppError("Request body exceeds the configured limit", "payload_too_large", 413));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("JSON body must be an object");
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new AppError("Request body must be valid JSON", "validation_error", 400));
      }
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () =>
      fail(new AppError("Request body upload was aborted", "request_timeout", 408));
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    timer = setTimeout(
      () => fail(new AppError("Request body read timed out", "request_timeout", 408)),
      options.timeoutMs,
    );
    if (contentLength > options.maxBytes) {
      req.resume();
      fail(new AppError("Request body exceeds the configured limit", "payload_too_large", 413));
      return;
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function headersRecord(req: IncomingMessage): Record<string, string | string[] | undefined> {
  return req.headers;
}

function hasDebugRole(ctx: RequestContext): boolean {
  return ctx.principal.roles.includes("BI_QUERY_DEBUG");
}

function hasAuditReaderRole(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.includes("BI_AUDIT_READER");
}

function hasModelAdminRole(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.includes("BI_MODEL_ADMIN");
}

function hasMetadataAdminRole(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.includes("BI_METADATA_ADMIN");
}

function hasExportApproverRole(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.includes("BI_EXPORT_APPROVER");
}

function hasEvaluationReviewerRole(principal: AuthenticatedPrincipal): boolean {
  return (
    principal.roles.includes("BI_EVAL_REVIEWER") ||
    principal.roles.includes("BI_QUERY_DEBUG")
  );
}

function publicAnalysisJob(job: {
  id: string;
  status: string;
  tenantId: string;
  subjectId: string;
  requestId: string;
  traceId: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}) {
  return {
    jobId: job.id,
    status: job.status,
    requestId: job.requestId,
    traceId: job.traceId,
    query: redactHistoryText(job.query),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result,
    error: job.error,
  };
}

function feedbackText(value: unknown, max = 4_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? redactHistoryText(trimmed).slice(0, max) : undefined;
}

function requireConfirmation(
  body: Record<string, unknown>,
  expected: string,
): void {
  if (body.confirm !== expected) {
    throw new AppError(
      `Explicit confirmation is required: confirm=${expected}`,
      "validation_error",
      400,
    );
  }
}

function requiresExportApproval(
  policy: AccessPolicy,
  columns: string[],
  rowCount: number,
  environment: BootstrapResult["config"]["environment"],
): boolean {
  const controls = policy.exportControls;
  if (controls?.requireApproval === true) return true;
  const threshold = Math.max(1, controls?.approvalRowThreshold ?? 1_000);
  if (rowCount >= threshold) return true;

  const sensitive = new Set(
    [
      ...(controls?.sensitiveColumns ?? []),
      ...(policy.maskRules ?? []).map((rule) => rule.column),
      ...Object.values(policy.deniedColumns ?? {}).flat(),
    ].map((column) => column.toLowerCase()),
  );
  if (columns.some((column) => sensitive.has(column.toLowerCase()))) return true;

  // Deployed environments default to approval unless policy explicitly opts
  // into a higher row threshold and the export remains below it.
  return (
    (environment === "staging" || environment === "production") &&
    controls?.approvalRowThreshold === undefined
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function secureHeaderMatches(
  provided: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || expected.length < 24) return false;
  const raw = Array.isArray(provided) ? provided[0] : provided;
  if (!raw) return false;
  const actual = Buffer.from(raw);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function pathname(url: string | undefined): string {
  if (!url) return "/";
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

function queryParams(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const q = url.indexOf("?");
  return new URLSearchParams(q >= 0 ? url.slice(q + 1) : "");
}

function normalizePagination(
  raw: number,
  fallback: number,
  options: { min: number; max: number },
): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(options.max, Math.max(options.min, Math.trunc(raw)));
}

async function probeDependency(url: string): Promise<{ healthy: boolean; latencyMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { healthy: response.ok, latencyMs: Date.now() - started };
  } catch {
    return { healthy: false, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function boundedHealthCheck(
  check: (() => Promise<{ healthy: boolean }>) | undefined,
  timeoutMs = 2_000,
): Promise<{ healthy: boolean }> {
  if (!check) return { healthy: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<{ healthy: boolean }>((resolve) =>
        (timer = setTimeout(() => resolve({ healthy: false }), timeoutMs)),
      ),
    ]);
  } catch {
    return { healthy: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readinessSnapshot(
  bootstrap: BootstrapResult,
  services: ProductizationServices,
): Promise<{ ready: boolean; checks: Record<string, unknown> }> {
  const checks: Record<string, unknown> = {};
  let ready = true;

  const configuredSources = bootstrap.profile.dataSourceRegistry
    .list()
    .filter((source) => source.supportStatus !== "planned");
  const registry = bootstrap.profile.executorRegistry;
  const executorHealth = registry ? await registry.healthCheckAll() : {};
  const missingExecutors = configuredSources
    .filter((source) => !registry?.has(source.id))
    .map((source) => source.id);
  const executorsHealthy =
    missingExecutors.length === 0 &&
    Object.values(executorHealth).every((status) => status.healthy);
  checks.executors = {
    healthy: executorsHealthy,
    configured: configuredSources.map((source) => source.id),
    missing: missingExecutors,
    statuses: Object.fromEntries(
      Object.entries(executorHealth).map(([id, status]) => [id, {
        healthy: status.healthy,
        latencyMs: status.latencyMs,
      }]),
    ),
  };
  ready &&= executorsHealthy;

  const auditHealth = await boundedHealthCheck(
    bootstrap.profile.auditSink.store?.healthCheck?.bind(
      bootstrap.profile.auditSink.store,
    ),
  );
  checks.audit = auditHealth;
  ready &&= auditHealth.healthy;

  const historyHealth = await boundedHealthCheck(
    services.historyStore.healthCheck?.bind(services.historyStore),
  );
  checks.history = historyHealth;
  ready &&= historyHealth.healthy;

  const checkpointer = bootstrap.profile.checkpointer as unknown as {
    healthCheck?: () => Promise<{ healthy: boolean }>;
  };
  const checkpointHealth = await boundedHealthCheck(
    checkpointer.healthCheck?.bind(checkpointer),
  );
  checks.checkpointer = checkpointHealth;
  ready &&= checkpointHealth.healthy;

  const queryCache = services.queryCache as unknown as {
    healthCheck?: () => Promise<{ healthy: boolean }>;
  };
  const cacheHealth = await boundedHealthCheck(
    queryCache.healthCheck?.bind(queryCache),
  );
  checks.queryCache = cacheHealth;
  ready &&= cacheHealth.healthy;

  const sessionHealth = await boundedHealthCheck(
    bootstrap.profile.sessionStore.healthCheck?.bind(
      bootstrap.profile.sessionStore,
    ),
  );
  checks.sessionState = sessionHealth;
  ready &&= sessionHealth.healthy;

  const persistentStateHealth = await boundedHealthCheck(
    services.healthCheck?.bind(services),
  );
  checks.persistentState = persistentStateHealth;
  ready &&= persistentStateHealth.healthy;

  for (const probe of bootstrap.readinessProbes ?? []) {
    const result = await probeDependency(probe.url);
    checks[probe.name] = result;
    ready &&= result.healthy;
  }

  return { ready, checks };
}

function bindRequestAbort(req: IncomingMessage, res?: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.on("aborted", onClose);
  req.on("close", () => {
    // 仅在客户端提前断开时 abort；正常结束后 close 也会触发
    if (!req.complete) onClose();
  });
  res?.on("close", () => {
    if (!res.writableEnded) onClose();
  });
  return controller.signal;
}

let cachedMetricFingerprint: string | undefined;

function resolveMetricVersionFingerprint(): string {
  if (!cachedMetricFingerprint) {
    cachedMetricFingerprint = MetricRegistry.fromDirectory(
      defaultMetricsDir(),
    ).versionFingerprint();
  }
  return cachedMetricFingerprint;
}

function buildAnalyzeCacheParts(
  principal: AuthenticatedPrincipal,
  policySnapshot: AccessPolicy,
  analyzeRequest: ReturnType<typeof parseAnalyzeRequest>,
  services: ProductizationServices,
): QueryCacheKeyParts {
  const choice = analyzeRequest.clarificationChoice;
  let dataSourceId: string | undefined;
  if (choice?.startsWith("datasource.")) {
    dataSourceId = choice.slice("datasource.".length);
  }
  return {
    tenantId: principal.tenantId,
    subjectId: principal.subjectId,
    policyVersion: policySnapshot.policyVersion,
    query: analyzeRequest.query,
    clarificationChoice: choice,
    dataSourceId,
    metadataVersion: services.schemaIndexer?.getSchemaVersion() ?? "0",
    metricVersion: resolveMetricVersionFingerprint(),
  };
}

function resolveServices(
  profile: BootstrapResult["profile"],
): ProductizationServices {
  if (profile.productization) {
    const services = profile.productization as ProductizationServices;
    if (!services.sloMonitor) {
      services.sloMonitor = createDefaultSloMonitor();
    }
    if (!services.metadataReview) {
      services.metadataReview = new InMemoryMetadataReviewStore();
    }
    if (!services.feedbackStore) {
      services.feedbackStore = new InMemoryAnalysisFeedbackStore();
    }
    if (!services.analysisJobs) {
      services.analysisJobs = new InMemoryAnalysisJobStore();
    }
    if (!services.telemetry) {
      services.telemetry = createDefaultTelemetry();
    }
    return services;
  }
  return {
    historyStore: new InMemoryQueryHistoryStore(),
    queryCache: new PermissionAwareQueryCache(),
    rateLimiter: new TenantRateLimiter(),
    exportJobs: new InMemoryExportJobStore(),
    modelRegistry: createDefaultModelRegistry(),
    sloMonitor: createDefaultSloMonitor(),
    metadataReview: new InMemoryMetadataReviewStore(),
    feedbackStore: new InMemoryAnalysisFeedbackStore(),
    analysisJobs: new InMemoryAnalysisJobStore(),
    telemetry: createDefaultTelemetry(),
  };
}

function buildAnalyzeResponse(
  result: Record<string, unknown>,
  requestContext: RequestContext,
  extras?: { cacheHit?: boolean },
): AnalyzeResponseBody {
  const model =
    requestContext.runtimeProfile.productization?.modelRegistry.resolveForSubject(
      requestContext.principal.subjectId,
    );
  const response: AnalyzeResponseBody = {
    finalAnswer: (result.finalAnswer as string) ?? "",
    chartSpec: result.chartSpec ?? undefined,
    meta: {
      queryPath: (result.queryPath as string | null) ?? null,
      confidence: (result.confidence as number | null) ?? null,
      requestId: requestContext.requestId,
      traceId: requestContext.traceId,
      cacheHit: extras?.cacheHit,
      modelVersionId: model?.id,
      dataFreshness:
        (result.dataFreshness as AnalyzeResponseBody["meta"]["dataFreshness"]) ?? {
          dataAsOf: new Date().toISOString(),
          timezone: "Asia/Shanghai",
          status: "unknown",
          warnings: ["元数据新鲜度不可用"],
        },
    },
    needsClarification: Boolean(result.clarification),
    clarification: result.clarification ?? undefined,
  };

  const execution = result.executionResult as
    | {
        degraded?: boolean;
        warnings?: string[];
        degradationReasons?: string[];
        rows?: Record<string, unknown>[];
        columns?: string[];
      }
    | null
    | undefined;
  const policyWarnings = execution?.warnings ?? [];
  const policyDegraded = execution?.degraded === true;
  if (policyDegraded || policyWarnings.length > 0) {
    response.finalAnswer = [
      response.finalAnswer,
      "",
      `Result policy: ${policyWarnings.join("; ") || "returned data was reduced"}`,
    ].join("\n");
    response.meta.resultPolicy = {
      degraded: policyDegraded,
      warnings: policyWarnings,
      reasons: execution?.degradationReasons ?? [],
      returnedRows: execution?.rows?.length ?? 0,
      returnedColumns: execution?.columns?.length ?? 0,
    };
  }

  if (hasDebugRole(requestContext) && result.generatedSql) {
    (response as AnalyzeResponseBody & { debugMeta?: unknown }).debugMeta = {
      dataSourceId: result.dataSourceId,
      generatedSql: result.generatedSql,
    };
  }
  return response;
}

function recordHistory(
  services: ProductizationServices,
  principal: AuthenticatedPrincipal,
  requestContext: RequestContext,
  query: string,
  result: Record<string, unknown>,
  durationMs?: number,
): void {
  const answer = String(result.finalAnswer ?? "");
  const exec = result.executionResult as
    | AnalyzeExecutionSnapshot
    | null
    | undefined;
  services.historyStore.append({
    id: `hist-${randomUUID()}`,
    tenantId: principal.tenantId,
    subjectId: principal.subjectId,
    sessionId: requestContext.sessionId,
    requestId: requestContext.requestId,
    traceId: requestContext.traceId,
    query: redactHistoryText(query),
    finalAnswerPreview: redactHistoryText(answer).slice(0, 240),
    queryPath: (result.queryPath as string | null) ?? null,
    dataSourceId: (result.dataSourceId as string) || undefined,
    needsClarification: Boolean(result.clarification),
    createdAt: new Date().toISOString(),
    durationMs,
    columns: exec?.columns,
    rows: redactHistoryRows(exec?.rows?.slice(0, 5_000), exec?.columns),
  });
}

function redactHistoryText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?\d[\s-]?){7,15}\b/g, "[redacted-phone]")
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 2_000);
}

function redactHistoryRows(
  rows: Record<string, unknown>[] | undefined,
  columns: string[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!rows) return undefined;
  const sensitive = /(?:email|e-mail|phone|mobile|token|secret|password|api[_-]?key|authorization)/i;
  return rows.map((row) => {
    const safe: Record<string, unknown> = {};
    for (const column of columns ?? Object.keys(row)) {
      const value = row[column];
      if (sensitive.test(column)) {
        safe[column] = "[redacted]";
      } else if (typeof value === "string") {
        safe[column] = redactHistoryText(value).slice(0, 500);
      } else if (value === null || typeof value === "number" || typeof value === "boolean") {
        safe[column] = value;
      } else {
        safe[column] = String(value).slice(0, 500);
      }
    }
    return safe;
  });
}

function writeSse(
  res: ServerResponse,
  event: string,
  data: unknown,
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function exportJobPublicView(job: {
  id: string;
  status: string;
  expiresAt: string;
  rowCount?: number;
  error?: string;
  requiresApproval: boolean;
  downloadCount: number;
  maxDownloads: number;
  approvedBy?: string;
  rejectedBy?: string;
  rejectReason?: string;
}) {
  const canDownload =
    job.status === "completed" && job.downloadCount < job.maxDownloads;
  return {
    jobId: job.id,
    status: job.status,
    expiresAt: job.expiresAt,
    rowCount: job.rowCount,
    error: job.error,
    requiresApproval: job.requiresApproval,
    downloadCount: job.downloadCount,
    maxDownloads: job.maxDownloads,
    approvedBy: job.approvedBy,
    rejectedBy: job.rejectedBy,
    rejectReason: job.rejectReason,
    downloadPath: canDownload ? `/api/export/${job.id}?format=csv` : undefined,
  };
}

export function createAppServer(bootstrap: BootstrapResult): AppServer {
  const { profile, config, localResources } = bootstrap;
  const db = localResources?.db;
  if (!db && profile.isLocal) {
    throw new AppError("本地 Profile 缺少数据库资源", "config_invalid", 500, false);
  }

  if (profile.auditSink.emitter) {
    setAuditEmitter(profile.auditSink.emitter);
  }
  setAuditLogger(profile.auditSink.logger);

  const services = resolveServices(profile);
  const stagingMockRateLimiter = new TenantRateLimiter(10, 60_000);
  const analysisJobRunner = new AnalysisJobRunner(
    services.analysisJobs,
    Number(process.env.ANALYSIS_JOB_CONCURRENCY ?? 2),
  );
  // 保证后续 createRequestContext 里的 profile 也能拿到同一批服务
  (profile as { productization?: ProductizationServices }).productization =
    services;

  if (!db && !profile.executorRegistry) {
    throw new AppError(
      "非本地 Profile 缺少 executorRegistry",
      "config_invalid",
      500,
      false,
    );
  }

  const graph = buildGraph({
    db: db ?? null,
    runtimeProfile: profile,
    schemaRetriever: profile.schemaRetriever,
    checkpointer: profile.checkpointer,
    executorRegistry: profile.executorRegistry,
  });
  let closePromise: Promise<void> | null = null;

  async function authenticateAndPrepare(
    req: IncomingMessage,
    body: Record<string, unknown>,
    response?: ServerResponse,
    preauthenticated?: AuthenticatedPrincipal,
  ): Promise<{
    principal: AuthenticatedPrincipal;
    analyzeRequest: ReturnType<typeof parseAnalyzeRequest>;
    policySnapshot: AccessPolicy;
    requestContext: RequestContext;
    threadId: string;
  }> {
    const principal =
      preauthenticated ??
      (await profile.authProvider.authenticate(headersRecord(req)));

    const limit = await services.rateLimiter.checkAsync(principal.tenantId, {
      subjectId: principal.subjectId,
      endpoint: pathname(req.url),
    });
    if (!limit.allowed) {
      throw new AppError(
        "租户请求过于频繁，请稍后重试",
        "rate_limited",
        429,
      );
    }

    const analyzeRequest = parseAnalyzeRequest(body);
    const policySnapshot = await loadPolicyForPrincipalAsync(principal, profile);

    if (analyzeRequest.sessionId) {
      if (profile.authProvider.validateSession) {
        await profile.authProvider.validateSession(
          principal,
          analyzeRequest.sessionId,
        );
      }
      try {
        await registerOrValidateSessionAsync(
          profile.sessionStore,
          principal,
          analyzeRequest.sessionId,
          policySnapshot.policyVersion,
        );
      } catch (err) {
        if (err instanceof AuthError && err.code === "policy_stale") {
          const n = services.queryCache.invalidateTenant(principal.tenantId);
          emitAuditEvent({
            event: "cache.invalidated",
            requestId: "n/a",
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            sessionId: analyzeRequest.sessionId,
            metadata: {
              reason: "policy_stale",
              purgedEntries: n,
              policyVersion: policySnapshot.policyVersion,
            },
          });
        }
        throw err;
      }
    }

    await services.modelRegistry.refreshAsync();
    const resolvedModel = services.modelRegistry.resolveForSubject(
      principal.subjectId,
    );
    const estimate = Math.ceil(analyzeRequest.query.length / 3) + 2_000;
    if (
      resolvedModel &&
      !services.modelRegistry.withinBudget(estimate, resolvedModel)
    ) {
      throw new AppError(
        "超出当前模型版本单请求成本预算",
        "budget_exceeded",
        429,
      );
    }

    const requestContext = createRequestContext({
      principal,
      policySnapshot,
      runtimeProfile: profile,
      sessionId: analyzeRequest.sessionId,
      clarificationChoice: analyzeRequest.clarificationChoice,
      timeoutMs: config.requestTimeoutMs,
      abortSignal: bindRequestAbort(req, response),
      traceId: parseTraceParent(req.headers.traceparent),
    });
    emitAuditEvent({
      event: "request.accepted",
      requestId: requestContext.requestId,
      traceId: requestContext.traceId,
      subjectId: principal.subjectId,
      tenantId: principal.tenantId,
      sessionId: analyzeRequest.sessionId,
    });
    emitAuditEvent({
      event: "auth.validated",
      requestId: requestContext.requestId,
      traceId: requestContext.traceId,
      subjectId: principal.subjectId,
      tenantId: principal.tenantId,
    });
    emitAuditEvent({
      event: "policy.loaded",
      requestId: requestContext.requestId,
      traceId: requestContext.traceId,
      subjectId: principal.subjectId,
      tenantId: principal.tenantId,
      metadata: { policyVersion: policySnapshot.policyVersion },
    });

    const threadId = analyzeRequest.sessionId
      ? buildSessionKey(
          principal.tenantId,
          principal.subjectId,
          analyzeRequest.sessionId,
        )
      : buildSessionKey(
          principal.tenantId,
          principal.subjectId,
          requestContext.requestId,
        );

    return {
      principal,
      analyzeRequest,
      policySnapshot,
      requestContext,
      threadId,
    };
  }

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestSpan = services.telemetry.startSpan("http.request", {
      "http.method": req.method ?? "UNKNOWN",
      "http.target": pathname(req.url),
    });
    services.telemetry.increment(`http.server.requests.${req.method ?? "UNKNOWN"}`);
    let requestContextForCleanup: RequestContext | undefined;
    let sloRecorded = false;
    const recordSlo = (success: boolean, code?: string) => {
      if (sloRecorded) return;
      sloRecorded = true;
      services.sloMonitor.record({
        durationMs: Date.now() - startedAt,
        success,
        code,
      });
    };

    try {
      const path = pathname(req.url);
      const readBody = () =>
        readJsonBody(req, {
          maxBytes: config.maxRequestBodyBytes,
          timeoutMs: config.requestBodyTimeoutMs,
        });

      if (
        req.method === "GET" &&
        (path === "/health" || path === "/live")
      ) {
        writeJson(res, 200, {
          status: "ok",
          environment: config.environment,
          liveDataSourceIds: bootstrap.liveDataSourceIds ?? [],
        });
        return;
      }

      if (req.method === "GET" && path === "/ready") {
        const snapshot = await readinessSnapshot(bootstrap, services);
        writeJson(res, snapshot.ready ? 200 : 503, {
          status: snapshot.ready ? "ready" : "not_ready",
          environment: config.environment,
          checks: snapshot.checks,
        });
        return;
      }

      // 单机 staging mock IdP：签发 JWT / 暴露 JWKS（仅 staging + BI_STAGING_MOCK_AUTH）
      if (
        isStagingMockAuthEnabled(process.env) &&
        req.method === "GET" &&
        path === "/api/staging/jwks.json"
      ) {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          throw new AppError("Staging mock endpoints are loopback-only", "forbidden", 403);
        }
        const mock = getStagingMockAuth();
        if (!mock) {
          throw new AppError("staging mock auth 未初始化", "config_invalid", 500);
        }
        writeJson(res, 200, mock.jwks);
        return;
      }

      if (
        isStagingMockAuthEnabled(process.env) &&
        req.method === "POST" &&
        path === "/api/staging/mock-token"
      ) {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          throw new AppError("Staging mock endpoints are loopback-only", "forbidden", 403);
        }
        if (
          !secureHeaderMatches(
            req.headers["x-bi-staging-admin-key"],
            process.env.BI_STAGING_MOCK_ADMIN_KEY,
          )
        ) {
          throw new AppError("Invalid staging mock admin key", "unauthenticated", 401);
        }
        const mockLimit = stagingMockRateLimiter.check(
          req.socket.remoteAddress ?? "loopback",
        );
        if (!mockLimit.allowed) {
          throw new AppError("Staging mock token rate limit exceeded", "rate_limited", 429);
        }
        const mock = getStagingMockAuth();
        if (!mock) {
          throw new AppError("staging mock auth 未初始化", "config_invalid", 500);
        }
        const body = await readBody();
        const token = await mock.issueToken({
          subjectId:
            typeof body.subjectId === "string" ? body.subjectId : undefined,
          tenantId:
            typeof body.tenantId === "string" ? body.tenantId : undefined,
          roles: Array.isArray(body.roles)
            ? body.roles.map(String)
            : undefined,
        });
        writeJson(res, 200, {
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }

      if (req.method === "GET" && path === "/api/metrics") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!principal.roles.includes("BI_QUERY_DEBUG")) {
          throw new AppError("需要 BI_QUERY_DEBUG 角色", "forbidden", 403);
        }
        writeJson(res, 200, {
          slo: services.sloMonitor.snapshot(),
          telemetry: services.telemetry.snapshot(),
        });
        return;
      }

      if (req.method === "GET" && path === "/api/semantic/metrics") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const registry = MetricRegistry.fromDirectory(defaultMetricsDir());
        const params = queryParams(req.url);
        const governance = params.get("governance") === "1";
        if (governance && !hasMetadataAdminRole(principal) && !hasEvaluationReviewerRole(principal)) {
          throw new AppError("需要 BI_METADATA_ADMIN 或 BI_EVAL_REVIEWER 角色", "forbidden", 403);
        }
        const metrics = (governance ? registry.listAll() : registry.listCertified()).map((metric) => ({
          ...metric,
          measure: { ...metric.measure },
          dimensions: metric.dimensions.map((dimension) => ({ ...dimension })),
          joinGraph: metric.joinGraph.map((edge) => ({ ...edge })),
          defaultFilters: metric.defaultFilters.map((filter) => ({ ...filter })),
          dependsOn: [...metric.dependsOn],
        }));
        writeJson(res, 200, {
          metrics,
          versionFingerprint: registry.versionFingerprint(),
          governance: governance
            ? {
                issues: registry.validateGovernance(),
                valid: registry.validateGovernance().every((issue) => issue.severity !== "error"),
              }
            : undefined,
        });
        return;
      }

      if (req.method === "POST" && path === "/api/feedback") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const body = await readBody();
        const rating = body.rating === "positive" || body.rating === "negative"
          ? body.rating
          : undefined;
        if (!rating) {
          throw new AppError("rating must be positive or negative", "validation_error", 400);
        }
        const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
        if (!requestId) {
          throw new AppError("requestId is required", "validation_error", 400);
        }
        const history = services.historyStore.getByRequestIdAsync
          ? await services.historyStore.getByRequestIdAsync(
              principal.tenantId,
              principal.subjectId,
              requestId,
            )
          : services.historyStore.getByRequestId(
              principal.tenantId,
              principal.subjectId,
              requestId,
            );
        const query = feedbackText(body.query, 2_000) ?? history?.query;
        if (!query) {
          throw new AppError("query is required when request history is unavailable", "validation_error", 400);
        }
        const categories = Array.isArray(body.categories)
          ? body.categories.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 12)
          : [];
        let feedback;
        try {
          feedback = await createFeedbackAsync(services.feedbackStore, {
            tenantId: principal.tenantId,
            subjectId: principal.subjectId,
            requestId,
            traceId: history?.traceId ?? (typeof body.traceId === "string" ? body.traceId : undefined),
            query,
            rating,
            categories,
            comment: feedbackText(body.comment),
            correctedSql: feedbackText(body.correctedSql, 20_000),
            expectedAnswer: feedbackText(body.expectedAnswer, 8_000),
            modelVersionId: typeof body.modelVersionId === "string" ? body.modelVersionId.slice(0, 200) : undefined,
          });
        } catch (error) {
          throw new AppError(error instanceof Error ? error.message : String(error), "validation_error", 400);
        }
        emitAuditEvent({
          event: "feedback.created",
          requestId,
          traceId: feedback.traceId ?? randomUUID(),
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: {
            feedbackId: feedback.id,
            rating: feedback.rating,
            categories: feedback.categories,
          },
        });
        writeJson(res, 201, { feedback });
        return;
      }

      if (req.method === "GET" && path === "/api/feedback") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const params = queryParams(req.url);
        const limit = normalizePagination(Number(params.get("limit") ?? "50"), 50, { min: 1, max: 200 });
        const offset = normalizePagination(Number(params.get("offset") ?? "0"), 0, {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        const options = {
          limit,
          offset,
          rating: params.get("rating") === "positive" || params.get("rating") === "negative"
            ? (params.get("rating") as "positive" | "negative")
            : undefined,
          requestId: params.get("requestId") ?? undefined,
          includePositive: params.get("includePositive") !== "false",
        };
        const tenantScope = params.get("scope") === "tenant";
        if (tenantScope && !hasEvaluationReviewerRole(principal)) {
          throw new AppError("需要 BI_EVAL_REVIEWER 角色", "forbidden", 403);
        }
        const items = tenantScope
          ? await listTenantFeedbackAsync(services.feedbackStore, principal.tenantId, options)
          : await listFeedbackAsync(services.feedbackStore, principal.tenantId, principal.subjectId, options);
        writeJson(res, 200, { items, offset, scope: tenantScope ? "tenant" : "subject" });
        return;
      }

      if (req.method === "GET" && path === "/api/feedback/replay") {
        const principal = await profile.authProvider.authenticate(headersRecord(req));
        if (!hasEvaluationReviewerRole(principal)) {
          throw new AppError("需要 BI_EVAL_REVIEWER 角色", "forbidden", 403);
        }
        const params = queryParams(req.url);
        const feedback = await listTenantFeedbackAsync(services.feedbackStore, principal.tenantId, {
          limit: normalizePagination(Number(params.get("limit") ?? "200"), 200, { min: 1, max: 200 }),
          offset: normalizePagination(Number(params.get("offset") ?? "0"), 0, {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
          }),
          rating: "negative",
          includePositive: false,
        });
        const cases = buildFeedbackReplayCases(feedback, {
          dialect: params.get("dialect") ?? "sqlite",
        });
        writeJson(res, 200, {
          cases,
          sourceFeedback: feedback.length,
          replayableCases: cases.length,
        });
        return;
      }

      const analysisJobMatch = path.match(/^\/api\/analyze\/jobs\/([^/]+)$/);
      if (req.method === "GET" && analysisJobMatch) {
        const principal = await profile.authProvider.authenticate(headersRecord(req));
        const job = services.analysisJobs.get(
          principal.tenantId,
          principal.subjectId,
          decodeURIComponent(analysisJobMatch[1]!),
        );
        if (!job) throw new AppError("Analysis job not found", "not_found", 404);
        writeJson(res, 200, publicAnalysisJob(job));
        return;
      }

      if (req.method === "POST" && path === "/api/analyze/jobs") {
        const authenticatedPrincipal = await profile.authProvider.authenticate(headersRecord(req));
        const body = await readBody();
        const prepared = await authenticateAndPrepare(req, body, undefined, authenticatedPrincipal);
        requestContextForCleanup = prepared.requestContext;
        const { principal, analyzeRequest, requestContext, threadId } = prepared;
        const job = services.analysisJobs.create({
          tenantId: principal.tenantId,
          subjectId: principal.subjectId,
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
          query: analyzeRequest.query,
        });
        emitAuditEvent({
          event: "analysis_job.created",
          requestId: job.requestId,
          traceId: job.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { jobId: job.id },
        });
        analysisJobRunner.enqueue(job.id, async (jobSignal) => {
          const span = services.telemetry.startSpan("analysis.job", {
            "analysis.job_id": job.id,
            "bi.request_id": requestContext.requestId,
          });
          const combined = new AbortController();
          const abort = () => combined.abort();
          requestContext.abortSignal.addEventListener("abort", abort, { once: true });
          jobSignal.addEventListener("abort", abort, { once: true });
          try {
            const result = (await graph.invoke(
              { messages: [new HumanMessage(analyzeRequest.query)] },
              {
                configurable: { requestContext, thread_id: threadId },
                signal: combined.signal,
              },
            )) as Record<string, unknown>;
            const durationMs = Date.now() - startedAt;
            const response = buildAnalyzeResponse(result, requestContext);
            recordHistory(services, principal, requestContext, analyzeRequest.query, result, durationMs);
            emitAuditEvent({
              event: "analysis_job.completed",
              requestId: requestContext.requestId,
              traceId: requestContext.traceId,
              subjectId: principal.subjectId,
              tenantId: principal.tenantId,
              dataSourceId: (result.dataSourceId as string) || undefined,
              durationMs,
              metadata: { jobId: job.id, queryPath: result.queryPath },
            });
            span.setAttribute("analysis.duration_ms", durationMs);
            span.end("ok");
            return response;
          } catch (error) {
            span.recordException(error);
            span.end("error");
            emitAuditEvent({
              event: "analysis_job.failed",
              requestId: requestContext.requestId,
              traceId: requestContext.traceId,
              subjectId: principal.subjectId,
              tenantId: principal.tenantId,
              metadata: { jobId: job.id },
            });
            throw error;
          } finally {
            requestContext.abortSignal.removeEventListener("abort", abort);
            jobSignal.removeEventListener("abort", abort);
          }
        });
        writeJson(res, 202, publicAnalysisJob(job));
        return;
      }

      const analysisJobCancelMatch = path.match(/^\/api\/analyze\/jobs\/([^/]+)\/cancel$/);
      if (req.method === "POST" && analysisJobCancelMatch) {
        const principal = await profile.authProvider.authenticate(headersRecord(req));
        const jobId = decodeURIComponent(analysisJobCancelMatch[1]!);
        const job = services.analysisJobs.cancel(principal.tenantId, principal.subjectId, jobId);
        if (!job) throw new AppError("Analysis job not found", "not_found", 404);
        analysisJobRunner.cancel(jobId);
        emitAuditEvent({
          event: "analysis_job.cancelled",
          requestId: job.requestId,
          traceId: job.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { jobId },
        });
        writeJson(res, 200, publicAnalysisJob(job));
        return;
      }

      if (req.method === "GET" && path === "/api/history") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const historyPolicy = await loadPolicyForPrincipalAsync(principal, profile);
        const configuredDays = Number(
          historyPolicy.historyRetentionDays ??
            process.env.HISTORY_RETENTION_DAYS ??
            "30",
        );
        const retentionDays = Number.isFinite(configuredDays)
          ? Math.min(3650, Math.max(1, Math.floor(configuredDays)))
          : 30;
        const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
        const purged = services.historyStore.purgeTenantOlderThanAsync
          ? await services.historyStore.purgeTenantOlderThanAsync(
              principal.tenantId,
              retentionMs,
            )
          : services.historyStore.purgeTenantOlderThan?.(
              principal.tenantId,
              retentionMs,
            ) ?? 0;
        if (purged > 0) {
          emitAuditEvent({
            event: "history.purged",
            requestId: randomUUID(),
            traceId: randomUUID(),
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: { purged, retentionDays },
          });
        }
        const params = queryParams(req.url);
        const limit = normalizePagination(
          Number(params.get("limit") ?? "20"),
          20,
          { min: 1, max: 100 },
        );
        const offset = normalizePagination(
          Number(params.get("offset") ?? "0"),
          0,
          { min: 0, max: Number.MAX_SAFE_INTEGER },
        );
        const historyOptions = { limit, offset };
        const items = services.historyStore.listAsync
          ? await services.historyStore.listAsync(
              principal.tenantId,
              principal.subjectId,
              historyOptions,
            )
          : services.historyStore.list(
              principal.tenantId,
              principal.subjectId,
              historyOptions,
            );
        emitAuditEvent({
          event: "history.accessed",
          requestId: randomUUID(),
          traceId: randomUUID(),
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { returned: items.length, offset },
        });
        writeJson(res, 200, { items, offset });
        return;
      }

      const historyDeleteMatch = path.match(/^\/api\/history\/([^/]+)$/);
      if (req.method === "DELETE" && historyDeleteMatch) {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        await loadPolicyForPrincipalAsync(principal, profile);
        const requestId = decodeURIComponent(historyDeleteMatch[1]!);
        const deleted = services.historyStore.deleteByRequestIdAsync
          ? await services.historyStore.deleteByRequestIdAsync(
              principal.tenantId,
              principal.subjectId,
              requestId,
            )
          : services.historyStore.deleteByRequestId?.(
              principal.tenantId,
              principal.subjectId,
              requestId,
            ) ?? 0;
        if (deleted === 0) {
          throw new AppError("History record not found", "not_found", 404);
        }
        emitAuditEvent({
          event: "history.deleted",
          requestId,
          traceId: randomUUID(),
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { deleted },
        });
        writeJson(res, 200, { deleted, requestId });
        return;
      }

      if (req.method === "GET" && path === "/api/queries/slow") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const params = queryParams(req.url);
        const minMs = Number(params.get("minMs") ?? "1000");
        const limit = Number(params.get("limit") ?? "20");
        const offset = Number(params.get("offset") ?? "0");
        const dataSourceId = params.get("dataSourceId") ?? undefined;
        const safeMin = Number.isFinite(minMs) ? minMs : 1000;
        const safeLimit = normalizePagination(limit, 20, { min: 1, max: 100 });
        const safeOffset = normalizePagination(offset, 0, {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        });

        const samples = services.slowQueryRecorder?.list({
          tenantId: principal.tenantId,
          minDurationMs: safeMin,
          limit: safeLimit,
          offset: safeOffset,
          dataSourceId: dataSourceId || undefined,
        });

        const historyOptions = {
          limit: safeLimit,
          offset: safeOffset,
          minDurationMs: safeMin,
        };
        const historyItems = services.historyStore.listAsync
          ? await services.historyStore.listAsync(
              principal.tenantId,
              principal.subjectId,
              historyOptions,
            )
          : services.historyStore.list(
              principal.tenantId,
              principal.subjectId,
              historyOptions,
            );
        writeJson(res, 200, {
          items: historyItems,
          samples: samples ?? [],
          minMs: safeMin,
          source: samples?.length ? "slow_query_recorder+history" : "history",
        });
        return;
      }

      if (req.method === "GET" && path === "/api/audit") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasAuditReaderRole(principal)) {
          throw new AppError("需要 BI_AUDIT_READER 角色", "forbidden", 403);
        }
        const store = profile.auditSink.store;
        if (!store) {
          writeJson(res, 200, { items: [], note: "当前未配置审计存储" });
          return;
        }
        if (profile.auditSink.retentionMs) {
          if (store.purgeOlderThanAsync) {
            await store.purgeOlderThanAsync(profile.auditSink.retentionMs);
          } else {
            store.purgeOlderThan(profile.auditSink.retentionMs);
          }
        }
        const params = queryParams(req.url);
        const offset = Number(params.get("offset") ?? "0");
        const auditFilter = {
          tenantId: principal.tenantId,
          subjectId: params.get("subjectId") ?? undefined,
          requestId: params.get("requestId") ?? undefined,
          event: params.get("event") ?? undefined,
          limit: Number(params.get("limit") ?? "50"),
          offset: Number.isFinite(offset) ? offset : 0,
        };
        const raw = store.queryAsync
          ? await store.queryAsync(auditFilter)
          : store.query(auditFilter);
        const level = principal.roles.includes("BI_QUERY_DEBUG")
          ? "full"
          : "summary";
        writeJson(res, 200, {
          items: redactAuditEvents(raw, level),
          fieldLevel: level,
          offset: Number.isFinite(offset) ? offset : 0,
        });
        return;
      }

      if (req.method === "GET" && path === "/api/models") {
        await profile.authProvider.authenticate(headersRecord(req));
        await services.modelRegistry.refreshAsync();
        writeJson(res, 200, {
          active: services.modelRegistry.getActive(),
          previousActive: services.modelRegistry.getPreviousActive(),
          canary: services.modelRegistry.getCanary(),
          rollout: services.modelRegistry.snapshot(),
          versions: services.modelRegistry.list(),
        });
        return;
      }

      if (req.method === "POST" && path === "/api/models/canary") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasModelAdminRole(principal)) {
          throw new AppError("需要 BI_MODEL_ADMIN 角色", "forbidden", 403);
        }
        const body = await readBody();
        requireConfirmation(
          body,
          body.clear === true ? "clear-canary" : "set-canary",
        );
        if (body.clear === true) {
          await services.modelRegistry.setCanaryAsync(null);
        } else {
          const canaryVersionId = body.canaryVersionId;
          const trafficPercent = Number(body.trafficPercent ?? 0);
          if (typeof canaryVersionId !== "string" || !canaryVersionId) {
            throw new AppError("canaryVersionId 必填", "validation_error", 400);
          }
          try {
            await services.modelRegistry.setCanaryAsync({
              canaryVersionId,
              trafficPercent,
            });
          } catch (err) {
            throw new AppError(
              err instanceof Error ? err.message : String(err),
              "validation_error",
              400,
            );
          }
        }
        emitAuditEvent({
          event: "model.canary_set",
          requestId: "n/a",
          traceId: "n/a",
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { canary: services.modelRegistry.getCanary() },
        });
        writeJson(res, 200, {
          canary: services.modelRegistry.getCanary(),
          rollout: services.modelRegistry.snapshot(),
        });
        return;
      }

      if (req.method === "POST" && path === "/api/models/promote") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasModelAdminRole(principal)) {
          throw new AppError("需要 BI_MODEL_ADMIN 角色", "forbidden", 403);
        }
        const body = await readBody();
        requireConfirmation(body, "promote-model");
        try {
          const active = await services.modelRegistry.promoteCanaryAsync();
          emitAuditEvent({
            event: "model.promoted",
            requestId: "n/a",
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: { activeId: active.id },
          });
          writeJson(res, 200, {
            active,
            rollout: services.modelRegistry.snapshot(),
          });
        } catch (err) {
          throw new AppError(
            err instanceof Error ? err.message : String(err),
            "conflict",
            409,
          );
        }
        return;
      }

      if (req.method === "POST" && path === "/api/models/rollback") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasModelAdminRole(principal)) {
          throw new AppError("需要 BI_MODEL_ADMIN 角色", "forbidden", 403);
        }
        const body = await readBody();
        requireConfirmation(body, "rollback-model");
        try {
          const active = await services.modelRegistry.rollbackAsync();
          emitAuditEvent({
            event: "model.rolled_back",
            requestId: "n/a",
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: { activeId: active.id },
          });
          writeJson(res, 200, {
            active,
            rollout: services.modelRegistry.snapshot(),
          });
        } catch (err) {
          throw new AppError(
            err instanceof Error ? err.message : String(err),
            "conflict",
            409,
          );
        }
        return;
      }

      if (req.method === "GET" && path === "/api/metadata/review") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasMetadataAdminRole(principal)) {
          throw new AppError(
            "需要 BI_METADATA_ADMIN 角色",
            "forbidden",
            403,
          );
        }
        const params = queryParams(req.url);
        const status = params.get("status") as
          | "draft"
          | "pending"
          | "approved"
          | "rejected"
          | null;
        writeJson(res, 200, {
          items: await listMetadataReviewsAsync(services.metadataReview, {
            status: status ?? undefined,
            datasourceId: params.get("datasourceId") ?? undefined,
            limit: Number(params.get("limit") ?? "50"),
          }),
        });
        return;
      }

      if (req.method === "POST" && path === "/api/metadata/describe") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasMetadataAdminRole(principal)) {
          throw new AppError(
            "需要 BI_METADATA_ADMIN 角色",
            "forbidden",
            403,
          );
        }
        const body = await readBody();
        if (typeof body.datasourceId !== "string" || typeof body.table !== "string") {
          throw new AppError(
            "datasourceId 与 table 必填",
            "validation_error",
            400,
          );
        }
        const draft = generateDraftDescription({
          datasourceId: body.datasourceId,
          table: body.table,
          column: typeof body.column === "string" ? body.column : undefined,
          dataType: typeof body.dataType === "string" ? body.dataType : undefined,
          domain: typeof body.domain === "string" ? body.domain : undefined,
          businessHint:
            typeof body.businessHint === "string" ? body.businessHint : undefined,
        });
        assertNoAutoCertification(draft);
        const saved = await upsertMetadataDraftAsync(
          services.metadataReview,
          draft,
        );
        emitAuditEvent({
          event: "metadata.draft_generated",
          requestId: "n/a",
          traceId: "n/a",
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { documentId: saved.id, reviewStatus: saved.reviewStatus },
        });
        writeJson(res, 201, { document: saved });
        return;
      }

      if (req.method === "POST" && path === "/api/metadata/review") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasMetadataAdminRole(principal)) {
          throw new AppError(
            "需要 BI_METADATA_ADMIN 角色",
            "forbidden",
            403,
          );
        }
        const body = await readBody();
        const documentId = body.documentId;
        const status = body.status;
        if (typeof documentId !== "string" || (status !== "approved" && status !== "rejected")) {
          throw new AppError(
            "documentId 与 status(approved|rejected) 必填",
            "validation_error",
            400,
          );
        }
        requireConfirmation(
          body,
          status === "approved" ? "approve-metadata" : "reject-metadata",
        );
        try {
          const updated = await decideMetadataReviewAsync(
            services.metadataReview,
            documentId,
            {
              status,
              reviewedBy: principal.subjectId,
              note: typeof body.note === "string" ? body.note : undefined,
            },
          );
          emitAuditEvent({
            event: "metadata.review_decided",
            requestId: "n/a",
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: { documentId, status },
          });
          writeJson(res, 200, { document: updated });
        } catch (err) {
          throw new AppError(
            err instanceof Error ? err.message : String(err),
            "conflict",
            409,
          );
        }
        return;
      }

      if (req.method === "POST" && path === "/api/metadata/sync/diff") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasMetadataAdminRole(principal)) {
          throw new AppError(
            "需要 BI_METADATA_ADMIN 角色",
            "forbidden",
            403,
          );
        }
        const body = await readBody();
        const previous = Array.isArray(body.previous)
          ? body.previous
          : services.schemaIndexer
            ? await services.schemaIndexer.readCurrentDocuments()
            : [];
        const next = Array.isArray(body.next) ? body.next : [];
        const diff = diffSchemaDocuments(
          previous as SchemaDocument[],
          next as SchemaDocument[],
        );
        const plan = planIncrementalSync(diff);
        writeJson(res, 200, {
          summary: {
            added: diff.added.length,
            changed: diff.changed.length,
            removed: diff.removed.length,
            unchanged: diff.unchanged.length,
          },
          plan: {
            upsertCount: plan.upsert.length,
            tombstoneIds: plan.tombstoneIds,
            skipped: plan.skipped,
          },
          changes: diff.changes,
        });
        return;
      }

      if (req.method === "POST" && path === "/api/metadata/sync/run") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasMetadataAdminRole(principal)) {
          throw new AppError(
            "需要 BI_METADATA_ADMIN 角色",
            "forbidden",
            403,
          );
        }
        const indexer = services.schemaIndexer;
        if (!indexer) {
          throw new AppError(
            "当前运行时未装配 SchemaIndexer，无法执行 metadata sync",
            "not_found",
            501,
          );
        }
        const body = await readBody();
        requireConfirmation(body, "run-metadata-sync");
        const next = Array.isArray(body.next)
          ? (body.next as SchemaDocument[])
          : Array.isArray(body.documents)
            ? (body.documents as SchemaDocument[])
            : [];
        if (next.length === 0) {
          throw new AppError(
            "next/documents 不能为空",
            "validation_error",
            400,
          );
        }
        const previous = Array.isArray(body.previous)
          ? (body.previous as SchemaDocument[])
          : undefined;
        const mode =
          body.mode === "rebuild" || body.mode === "incremental"
            ? body.mode
            : undefined;
        const result = await runMetadataSync({
          indexer,
          nextDocuments: next,
          previousDocuments: previous,
          mode,
          shardByTable: body.shardByTable === true,
        });
        const purged = services.queryCache.invalidateByMetadataVersion(
          principal.tenantId,
          indexer.getSchemaVersion(),
        );
        emitAuditEvent({
          event: "metadata.sync_applied",
          requestId: randomUUID(),
          traceId: randomUUID(),
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: {
            mode: result.mode,
            upserted: result.upserted,
            tombstoned: result.tombstoned,
            collection: result.collection,
            alias: result.aliasSwap?.alias,
            cachePurged: purged,
            metadataVersion: indexer.getSchemaVersion(),
          },
        });
        writeJson(res, 200, {
          mode: result.mode,
          upserted: result.upserted,
          tombstoned: result.tombstoned,
          collection: result.collection,
          aliasSwap: result.aliasSwap
            ? {
                alias: result.aliasSwap.alias,
                newCollection: result.aliasSwap.newCollection,
                previousCollection: result.aliasSwap.previousCollection,
                indexedCount: result.aliasSwap.indexedCount,
              }
            : undefined,
          summary: {
            added: result.diff.added.length,
            changed: result.diff.changed.length,
            removed: result.diff.removed.length,
            unchanged: result.diff.unchanged.length,
          },
          shardedTotals: result.sharded?.totals,
        });
        return;
      }

      if (req.method === "POST" && path === "/api/metadata/alias/rollback") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasMetadataAdminRole(principal)) {
          throw new AppError(
            "需要 BI_METADATA_ADMIN 角色",
            "forbidden",
            403,
          );
        }
        const indexer = services.schemaIndexer;
        if (!indexer) {
          throw new AppError(
            "当前运行时未装配 SchemaIndexer，无法执行 alias 回滚",
            "not_found",
            501,
          );
        }
        const body = await readBody();
        requireConfirmation(body, "rollback-metadata-alias");
        const previousCollection = String(body.previousCollection ?? "").trim();
        if (!previousCollection) {
          throw new AppError(
            "previousCollection 必填",
            "validation_error",
            400,
          );
        }
        try {
          await indexer.rollbackAlias(previousCollection);
          const target = await indexer.getAliasTarget();
          emitAuditEvent({
            event: "metadata.alias_rolled_back",
            requestId: "n/a",
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: {
              alias: indexer.collectionAlias,
              previousCollection,
              target,
            },
          });
          writeJson(res, 200, {
            alias: indexer.collectionAlias,
            target,
            previousCollection,
          });
        } catch (err) {
          throw new AppError(
            err instanceof Error ? err.message : String(err),
            "conflict",
            409,
          );
        }
        return;
      }

      if (req.method === "POST" && path === "/api/export") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const body = await readBody();
        const requestId = body.requestId;
        if (typeof requestId !== "string" || !requestId) {
          throw new AppError("requestId 必填", "validation_error", 400);
        }
        const hist = services.historyStore.getByRequestIdAsync
          ? await services.historyStore.getByRequestIdAsync(
              principal.tenantId,
              principal.subjectId,
              requestId,
            )
          : services.historyStore.getByRequestId(
              principal.tenantId,
              principal.subjectId,
              requestId,
            );
        if (!hist?.rows?.length || !hist.columns?.length) {
          throw new AppError(
            "无可导出结果（需先完成可返回行数据的查询）",
            "not_found",
            404,
          );
        }
        const exportPolicy = await loadPolicyForPrincipalAsync(principal, profile);
        const requireApproval = requiresExportApproval(
          exportPolicy,
          hist.columns,
          hist.rows.length,
          config.environment,
        );
        const job = await createExportJobAsync(services.exportJobs, {
          tenantId: principal.tenantId,
          subjectId: principal.subjectId,
          requestId,
          columns: hist.columns,
          rows: hist.rows,
          requireApproval,
        });
        emitAuditEvent({
          event: "export.created",
          requestId,
          traceId: hist.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: {
            jobId: job.id,
            status: job.status,
            requireApproval,
            rowCount: job.rowCount,
          },
        });
        writeJson(res, 202, exportJobPublicView(job));
        return;
      }

      const exportApproveMatch = path.match(/^\/api\/export\/([^/]+)\/approve$/);
      if (req.method === "POST" && exportApproveMatch) {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasExportApproverRole(principal)) {
          throw new AppError(
            "需要 BI_EXPORT_APPROVER 角色",
            "forbidden",
            403,
          );
        }
        const body = await readBody();
        requireConfirmation(body, "approve-export");
        const jobId = exportApproveMatch[1]!;
        try {
          const job = await approveExportJobAsync(
            services.exportJobs,
            principal.tenantId,
            jobId,
            principal.subjectId,
          );
          emitAuditEvent({
            event: "export.approved",
            requestId: job.requestId,
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: { jobId: job.id, ownerSubjectId: job.subjectId },
          });
          writeJson(res, 200, exportJobPublicView(job));
        } catch (err) {
          throw new AppError(
            err instanceof Error ? err.message : String(err),
            "conflict",
            409,
          );
        }
        return;
      }

      const exportRejectMatch = path.match(/^\/api\/export\/([^/]+)\/reject$/);
      if (req.method === "POST" && exportRejectMatch) {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        if (!hasExportApproverRole(principal)) {
          throw new AppError(
            "需要 BI_EXPORT_APPROVER 角色",
            "forbidden",
            403,
          );
        }
        const jobId = exportRejectMatch[1]!;
        const body = await readBody();
        requireConfirmation(body, "reject-export");
        const reason =
          typeof body.reason === "string" ? body.reason : undefined;
        try {
          const job = await rejectExportJobAsync(
            services.exportJobs,
            principal.tenantId,
            jobId,
            principal.subjectId,
            reason,
          );
          emitAuditEvent({
            event: "export.rejected",
            requestId: job.requestId,
            traceId: "n/a",
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            metadata: {
              jobId: job.id,
              ownerSubjectId: job.subjectId,
              reason,
            },
          });
          writeJson(res, 200, exportJobPublicView(job));
        } catch (err) {
          throw new AppError(
            err instanceof Error ? err.message : String(err),
            "conflict",
            409,
          );
        }
        return;
      }

      if (req.method === "GET" && path.startsWith("/api/export/")) {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const jobId = path.slice("/api/export/".length);
        if (jobId.includes("/")) {
          throw new AppError("Not Found", "not_found", 404);
        }
        const job = await getExportJobAsync(
          services.exportJobs,
          principal.tenantId,
          principal.subjectId,
          jobId,
        );
        if (!job) {
          throw new AppError("导出任务不存在", "not_found", 404);
        }
        const format = queryParams(req.url).get("format");
        if (format === "csv") {
          try {
            const { csv } = await takeExportDownloadAsync(
              services.exportJobs,
              principal.tenantId,
              principal.subjectId,
              jobId,
            );
            emitAuditEvent({
              event: "export.downloaded",
              requestId: job.requestId,
              traceId: "n/a",
              subjectId: principal.subjectId,
              tenantId: principal.tenantId,
              metadata: { jobId: job.id },
            });
            res.writeHead(200, {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="${job.id}.csv"`,
            });
            res.end(csv);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/approval/i.test(message)) {
              throw new AppError(message, "approval_required", 403);
            }
            if (/expired|download limit/i.test(message)) {
              throw new AppError(message, "not_found", 410);
            }
            if (message.includes("待审批")) {
              throw new AppError(message, "approval_required", 403);
            }
            if (message.includes("已过期") || message.includes("下载次数已用尽")) {
              throw new AppError(message, "not_found", 410);
            }
            throw new AppError(message, "conflict", 409);
          }
          return;
        }
        writeJson(res, 200, exportJobPublicView(job));
        return;
      }

      if (req.method === "POST" && path === "/api/analyze") {
        const authenticatedPrincipal = await profile.authProvider.authenticate(headersRecord(req));
        const body = await readBody();
        const prepared = await authenticateAndPrepare(req, body, res, authenticatedPrincipal);
        requestContextForCleanup = prepared.requestContext;
        const { principal, analyzeRequest, policySnapshot, requestContext, threadId } =
          prepared;

        const cacheParts = buildAnalyzeCacheParts(
          principal,
          policySnapshot,
          analyzeRequest,
          services,
        );
        const cacheKey = PermissionAwareQueryCache.buildKey(cacheParts);
        const asyncCache = services.queryCache as PermissionAwareQueryCache & {
          getAsync?: (
            key: string,
            expect: QueryCacheKeyParts,
          ) => Promise<unknown>;
        };
        const cached = (asyncCache.getAsync
          ? await asyncCache.getAsync(cacheKey, cacheParts)
          : services.queryCache.get(cacheKey, cacheParts)) as
          | AnalyzeCacheEntry
          | AnalyzeResponseBody
          | undefined;
        if (cached && !analyzeRequest.sessionId) {
          const cachedResponse = isAnalyzeCacheEntry(cached)
            ? cached.response
            : cached;
          const hit = {
            ...cachedResponse,
            meta: {
              ...cachedResponse.meta,
              requestId: requestContext.requestId,
              traceId: requestContext.traceId,
              cacheHit: true,
            },
          };
          if (isAnalyzeCacheEntry(cached)) {
            recordHistory(
              services,
              principal,
              requestContext,
              analyzeRequest.query,
              {
                finalAnswer: cachedResponse.finalAnswer,
                queryPath: cachedResponse.meta.queryPath,
                clarification: cachedResponse.clarification,
                dataSourceId: cached.dataSourceId,
                executionResult: cached.executionResult,
              },
              0,
            );
          }
          recordSlo(true);
          writeJson(res, 200, hit);
          return;
        }

        const result = (await graph.invoke(
          { messages: [new HumanMessage(analyzeRequest.query)] },
          {
            configurable: {
              requestContext,
              thread_id: threadId,
            },
            signal: requestContext.abortSignal,
          },
        )) as Record<string, unknown>;

        const durationMs = Date.now() - startedAt;
        emitAuditEvent({
          event: "answer.completed",
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          dataSourceId: (result.dataSourceId as string) || undefined,
          durationMs,
          metadata: {
            queryPath: result.queryPath,
            retryCount: result.retryCount,
          },
        });

        const response = buildAnalyzeResponse(result, requestContext);
        recordHistory(
          services,
          principal,
          requestContext,
          analyzeRequest.query,
          result,
          durationMs,
        );

        if (!response.needsClarification && !analyzeRequest.sessionId) {
          const cacheEntry = toAnalyzeCacheEntry(response, result);
          services.queryCache.set(cacheKey, cacheParts, cacheEntry);
          const lq = result.logicalQuery as LogicalQuery | null | undefined;
          if (lq && typeof lq === "object" && "source" in lq) {
            const hashedParts: QueryCacheKeyParts = {
              ...cacheParts,
              logicalQueryHash: hashLogicalQuery(lq),
              dataSourceId:
                cacheParts.dataSourceId ??
                (result.dataSourceId as string | undefined),
            };
            services.queryCache.set(
              PermissionAwareQueryCache.buildKey(hashedParts),
              hashedParts,
              cacheEntry,
            );
          }
        }

        recordSlo(true);
        writeJson(res, 200, response);
        return;
      }

      if (req.method === "POST" && path === "/api/analyze/stream") {
        const authenticatedPrincipal = await profile.authProvider.authenticate(headersRecord(req));
        const body = await readBody();
        const prepared = await authenticateAndPrepare(req, body, res, authenticatedPrincipal);
        requestContextForCleanup = prepared.requestContext;
        const { principal, analyzeRequest, requestContext, threadId } =
          prepared;

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
          connection: "keep-alive",
        });
        writeSse(res, "status", {
          phase: "started",
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
        });

        let lastState: Record<string, unknown> = {};
        let terminalEventSent = false;
        const heartbeat = setInterval(() => {
          if (!writeSse(res, "heartbeat", { at: new Date().toISOString() })) {
            requestContext.abortSignal.throwIfAborted?.();
          }
        }, 15_000);
        if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
        try {
          const stream = await graph.stream(
            { messages: [new HumanMessage(analyzeRequest.query)] },
            {
              configurable: {
                requestContext,
                thread_id: threadId,
              },
              streamMode: "updates",
              signal: requestContext.abortSignal,
            },
          );

          for await (const chunk of stream) {
            writeSse(res, "status", { phase: "running", requestId: requestContext.requestId });
            const entries = Object.entries(chunk as Record<string, unknown>);
            for (const [node, update] of entries) {
              writeSse(res, "node", {
                node,
                keys:
                  update && typeof update === "object"
                    ? Object.keys(update as object)
                    : [],
              });
              if (update && typeof update === "object") {
                lastState = { ...lastState, ...(update as object) };
              }
            }
          }

          const durationMs = Date.now() - startedAt;
          emitAuditEvent({
            event: "answer.completed",
            requestId: requestContext.requestId,
            traceId: requestContext.traceId,
            subjectId: principal.subjectId,
            tenantId: principal.tenantId,
            dataSourceId: (lastState.dataSourceId as string) || undefined,
            durationMs,
            metadata: { queryPath: lastState.queryPath, streamed: true },
          });

          const response = buildAnalyzeResponse(lastState, requestContext);
          recordHistory(
            services,
            principal,
            requestContext,
            analyzeRequest.query,
            lastState,
            durationMs,
          );
          if (response.needsClarification) {
            writeSse(res, "clarification", response.clarification);
          }
          writeSse(res, "answer", response);
          writeSse(res, "status", { phase: "completed", requestId: requestContext.requestId });
          writeSse(res, "done", { ok: true });
          terminalEventSent = true;
          recordSlo(true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code =
            err instanceof AppError
              ? err.code
              : err instanceof AuthError
                ? err.code
                : "internal_error";
          writeSse(res, "error", { error: message, code });
          writeSse(res, "status", {
            phase: requestContext.abortSignal.aborted ? "cancelled" : "error",
            requestId: requestContext.requestId,
            code,
          });
          writeSse(res, "done", { ok: false, code });
          terminalEventSent = true;
          recordSlo(false, code);
        } finally {
          clearInterval(heartbeat);
          if (!terminalEventSent && !res.writableEnded) {
            writeSse(res, "done", { ok: false, code: "stream_ended" });
          }
        }
        res.end();
        return;
      }

      writeJson(res, 404, { error: "Not Found", code: "not_found" });
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof AuthError
            ? error.code
            : "unknown";
      recordSlo(false, code);

      emitAuditEvent({
        event: "request.failed",
        requestId: "unknown",
        traceId: "unknown",
        subjectId: "unknown",
        tenantId: "unknown",
        failureKind: code,
        metadata: {
          message: error instanceof Error ? error.message : String(error),
        },
      });

      if (error instanceof AuthError) {
        const statusCode =
          error.code === "forged_identity" || error.code === "unauthenticated"
            ? 401
            : error.code === "policy_stale"
              ? 409
              : 403;
        writeJson(res, statusCode, { error: error.message, code: error.code });
        return;
      }

      const client = toClientError(error);
      writeJson(res, client.statusCode, client.body);
    } finally {
      requestSpan.setAttribute("http.status_code", res.statusCode);
      requestSpan.setAttribute("http.duration_ms", Date.now() - startedAt);
      requestSpan.end(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "error" : "ok");
      requestContextForCleanup?.dispose();
    }
  });

  return {
    server,
    graph,
    profile,
    services,
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          const closeFailures: unknown[] = [];
          try {
            await analysisJobRunner.close();
            await services.telemetry.flush();
          } catch (error) {
            closeFailures.push(error);
          }
          if (server.listening) {
            try {
              await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
              });
            } catch (error) {
              closeFailures.push(error);
            }
          }

          const resources: Array<{ name: string; value: unknown }> = [
            { name: "executors", value: profile.executorRegistry },
            { name: "query cache", value: services.queryCache },
            { name: "history store", value: services.historyStore },
            { name: "productization services", value: services },
            { name: "session store", value: profile.sessionStore },
            { name: "audit store", value: profile.auditSink.store },
            { name: "checkpointer", value: profile.checkpointer },
          ];
          const seen = new Set<unknown>();
          const closes = resources.flatMap(({ name, value }) => {
            if (!value || seen.has(value)) return [];
            seen.add(value);
            if (name === "executors") {
              return [
                profile.executorRegistry!.closeAll().catch((error) => {
                  throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
                }),
              ];
            }
            const close = (value as { close?: () => Promise<void> }).close;
            if (typeof close !== "function") return [];
            return [
              Promise.resolve()
                .then(() => close.call(value))
                .catch((error) => {
                  throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
                }),
            ];
          });
          const results = await Promise.allSettled(closes);

          try {
            if (localResources?.db.open) localResources.db.close();
          } catch (error) {
            closeFailures.push(error);
          }
          const failures = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
          failures.push(...closeFailures);
          if (failures.length > 0) {
            throw new AggregateError(failures, "Failed to close BI runtime resources");
          }
        })();
      }
      await closePromise;
    },
  };
}

export function startAppServer(bootstrap: BootstrapResult, port: number) {
  const app = createAppServer(bootstrap);
  app.server.listen(port, () => {
    console.info(`[bi-analyst] listening on :${port}`);
  });
  return app;
}
