import type { AppConfig, ProductizationServices } from "../config/types.js";
import { PostgresQueryHistoryStore } from "../history/postgres-store.js";
import { InMemoryQueryHistoryStore } from "../history/store.js";
import {
  createQueryCacheFromEnv,
  RespRedisCacheBackend,
} from "../cache/redis-query-cache.js";
import {
  RedisTenantRateLimiter,
  TenantRateLimiter,
} from "../runtime/rate-limit.js";
import { InMemoryExportJobStore } from "../export/csv.js";
import { RedisExportJobStore } from "../export/redis-store.js";
import {
  createDefaultModelRegistry,
} from "../governance/model-registry.js";
import { RedisModelVersionRegistry } from "../governance/redis-model-registry.js";
import { createDefaultSloMonitor } from "../runtime/slo.js";
import { createAlertSink } from "../runtime/alert-sink.js";
import { InMemorySlowQueryRecorder } from "../runtime/slow-query.js";
import {
  PersistentAnalysisFeedbackStore,
} from "../governance/feedback.js";
import { PersistentAnalysisJobStore } from "../runtime/analysis-jobs.js";
import { createDefaultTelemetry } from "../runtime/telemetry.js";
import {
  InMemoryMetadataReviewStore,
} from "../metadata/review.js";
import { RedisMetadataReviewStore } from "../metadata/redis-review-store.js";
import { emitAuditEvent } from "../audit/events.js";

/**
 * staging/production 产品化服务装配：
 * - HISTORY_DATABASE_URL / AUDIT_DATABASE_URL → PostgresQueryHistoryStore
 * - REDIS_URL → Redis L1+L2 查询缓存
 */
export function createProductizationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  config?: AppConfig,
): ProductizationServices {
  const production = config?.environment === "production";
  const stateBackend =
    production && env.REDIS_URL
      ? new RespRedisCacheBackend(env.REDIS_URL)
      : undefined;
  const historyStore =
    env.HISTORY_DATABASE_URL || env.AUDIT_DATABASE_URL
      ? new PostgresQueryHistoryStore({
          connectionString:
            env.HISTORY_DATABASE_URL || env.AUDIT_DATABASE_URL,
          encryptionSecret: env.HISTORY_ENCRYPTION_SECRET,
        })
      : new InMemoryQueryHistoryStore();

  const exportSecret = env.EXPORT_ENCRYPTION_SECRET;
  const stateEncryptionSecret =
    env.ANALYSIS_STATE_ENCRYPTION_SECRET ||
    env.HISTORY_ENCRYPTION_SECRET ||
    exportSecret;
  const stateRoot = env.STATE_VOLUME_PATH?.trim() || "./data";
  const alertSink = createAlertSink(env);
  const defaultModels = createDefaultModelRegistry();
  const modelRegistry = stateBackend
    ? new RedisModelVersionRegistry(stateBackend, defaultModels.list())
    : defaultModels;

  return {
    historyStore,
    queryCache: createQueryCacheFromEnv(env, {
      maxEntries: config?.deployment.queryCacheMaxEntries,
      ttlMs: config?.deployment.queryCacheTtlMs,
    }),
    rateLimiter: env.REDIS_URL
      ? new RedisTenantRateLimiter(
          new RespRedisCacheBackend(env.REDIS_URL),
          config?.deployment.rateLimitMax ?? 120,
          config?.deployment.rateLimitWindowMs ?? 60_000,
        )
      : new TenantRateLimiter(
          config?.deployment.rateLimitMax ?? 120,
          config?.deployment.rateLimitWindowMs ?? 60_000,
        ),
    exportJobs: stateBackend
      ? new RedisExportJobStore(stateBackend, exportSecret ?? "")
      : new InMemoryExportJobStore({ encryptionSecret: exportSecret }),
    modelRegistry,
    metadataReview: stateBackend
      ? new RedisMetadataReviewStore(stateBackend)
      : new InMemoryMetadataReviewStore(),
    slowQueryRecorder: new InMemorySlowQueryRecorder(),
    feedbackStore: new PersistentAnalysisFeedbackStore(
      env.FEEDBACK_STATE_PATH?.trim() || `${stateRoot}/analysis-feedback.json`,
      stateEncryptionSecret,
    ),
    analysisJobs: new PersistentAnalysisJobStore(
      env.ANALYSIS_JOBS_STATE_PATH?.trim() || `${stateRoot}/analysis-jobs.json`,
      stateEncryptionSecret,
    ),
    telemetry: createDefaultTelemetry(env),
    alertSink,
    sloMonitor: createDefaultSloMonitor((alert) => {
      void alertSink.notify(alert);
      emitAuditEvent({
        event: "slo.alert",
        requestId: "n/a",
        traceId: "n/a",
        subjectId: "system",
        tenantId: "system",
        metadata: {
          kind: alert.kind,
          threshold: alert.threshold,
          actual: alert.actual,
          at: alert.at,
        },
      });
    }),
    initialize: stateBackend
      ? async () => {
          await stateBackend.ping?.();
          await modelRegistry.initializeAsync();
        }
      : undefined,
    healthCheck: stateBackend
      ? async () => {
          try {
            await stateBackend.ping?.();
            return { healthy: true };
          } catch {
            return { healthy: false };
          }
        }
      : undefined,
    close: stateBackend
      ? async () => {
          await stateBackend.close?.();
        }
      : undefined,
  };
}
