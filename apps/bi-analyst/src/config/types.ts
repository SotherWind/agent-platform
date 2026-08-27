import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AnalyzeRequest } from "../auth/types.js";
import type { AuditLogger } from "../audit/logger.js";
import type { AuditEmitter } from "../audit/events.js";
import type { AuditStore } from "../audit/store.js";
import type { DataSourceRegistry } from "../datasource/registry.js";
import type { SecretProvider } from "../datasource/secrets.js";
import type { ExecutorRegistry } from "../datasource/executor-registry.js";
import type { SchemaRetriever } from "../metadata/retriever.js";
import type { SessionStore } from "../session/store.js";
import type { PolicyProvider } from "../policy/policy-provider.js";
import type { QueryHistoryStore } from "../history/store.js";
import type { PermissionAwareQueryCache } from "../cache/query-cache.js";
import type { TenantRateLimiter } from "../runtime/rate-limit.js";
import type { ExportJobStore } from "../export/csv.js";
import type { ModelVersionRegistry } from "../governance/model-registry.js";
import type { SloMonitor } from "../runtime/slo.js";
import type { MetadataReviewStore } from "../metadata/review.js";
import type { AlertSink } from "../runtime/alert-sink.js";
import type { SchemaIndexer } from "../metadata/indexer.js";
import type { SlowQueryRecorder } from "../runtime/slow-query.js";
import type { AnalysisFeedbackStore } from "../governance/feedback.js";
import type { AnalysisJobStore } from "../runtime/analysis-jobs.js";
import type { Telemetry } from "../runtime/telemetry.js";

export const APP_ENVIRONMENTS = [
  "development",
  "test",
  "staging",
  "production",
] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export interface AppConfig {
  environment: AppEnvironment;
  port: number;
  maxRetryCount: number;
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
  requestBodyTimeoutMs: number;
  configVersion: string;
  deployment: {
    datasourcePoolMax: number;
    tenantConcurrencyMax: number;
    rateLimitMax: number;
    rateLimitWindowMs: number;
    queryCacheMaxEntries: number;
    queryCacheTtlMs: number;
    slowQueryThresholdMs: number;
  };
}

export interface AuthProvider {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedPrincipal>;
  validateSession?(
    principal: AuthenticatedPrincipal,
    sessionId: string,
  ): Promise<void>;
}

export interface AuditSink {
  logger: AuditLogger;
  emitter?: AuditEmitter;
  store?: AuditStore;
  /** 默认保留时长（purge 用） */
  retentionMs?: number;
}

export interface ProductizationServices {
  historyStore: QueryHistoryStore;
  queryCache: PermissionAwareQueryCache;
  rateLimiter: TenantRateLimiter;
  exportJobs: ExportJobStore;
  modelRegistry: ModelVersionRegistry;
  sloMonitor: SloMonitor;
  metadataReview: MetadataReviewStore;
  alertSink?: AlertSink;
  /** 可选：metadata alias 回滚（本地/staging 演练） */
  schemaIndexer?: SchemaIndexer;
  /** Phase E：慢查询 EXPLAIN/耗时采样 */
  slowQueryRecorder?: SlowQueryRecorder;
  /** Human feedback used for evaluation regression and analyst corrections. */
  feedbackStore: AnalysisFeedbackStore;
  /** Durable status for long-running analysis requests. */
  analysisJobs: AnalysisJobStore;
  /** Vendor-neutral spans/counters; optionally exported through OTLP. */
  telemetry: Telemetry;
  initialize?(): Promise<void>;
  healthCheck?(): Promise<{ healthy: boolean }>;
  close?(): Promise<void>;
}

export interface RuntimeProfile {
  environment: AppEnvironment;
  isLocal: boolean;
  authProvider: AuthProvider;
  secretProvider: SecretProvider;
  dataSourceRegistry: DataSourceRegistry;
  schemaRetriever: SchemaRetriever;
  checkpointer: BaseCheckpointSaver;
  auditSink: AuditSink;
  sessionStore: SessionStore;
  policyProvider: PolicyProvider;
  /** Phase D：按 dataSourceId 解析 SqlExecutor */
  executorRegistry?: ExecutorRegistry;
  /** Phase E：历史/缓存/限流/导出/模型治理（可选，缺省时 API 侧建默认实例） */
  productization?: ProductizationServices;
}

export interface AnalyzeHandlerInput {
  request: AnalyzeRequest;
  principal: AuthenticatedPrincipal;
  requestId: string;
  traceId: string;
}
