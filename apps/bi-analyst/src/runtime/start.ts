import { purgeAuditStoreIfConfiguredAsync } from "../audit/sink.js";
import { startAppServer } from "../api/server.js";
import type { BootstrapResult } from "../bootstrap/runtime-common.js";
import { logBootstrapSummary } from "../bootstrap/runtime-common.js";
import { purgeExpiredSessionsAsync } from "../session/store.js";

export async function startRuntime(bootstrap: BootstrapResult) {
  logBootstrapSummary(bootstrap);
  await bootstrap.profile.productization?.initialize?.();
  if (bootstrap.config.environment === "production") {
    const sessionHealth = await bootstrap.profile.sessionStore.healthCheck?.();
    if (sessionHealth && !sessionHealth.healthy) {
      throw new Error("Production session state backend is unavailable");
    }
  }
  await purgeExpiredSessionsAsync(bootstrap.profile.sessionStore);

  void purgeAuditStoreIfConfiguredAsync(bootstrap.profile.auditSink)
    .then((purged) => {
      if (purged > 0) {
        console.info(`[bi-analyst] audit purge removed ${purged} events`);
      }
    })
    .catch((error) => console.warn("[bi-analyst] initial audit purge failed", error));

  const historyRetentionDays = Number(process.env.HISTORY_RETENTION_DAYS ?? 30);
  const historyRetentionMs =
    Math.max(1, historyRetentionDays) * 24 * 60 * 60 * 1000;
  const purgeHistory = async () => {
    const store = bootstrap.profile.productization?.historyStore;
    if (!store) return 0;
    if (store.purgeOlderThanAsync) {
      return store.purgeOlderThanAsync(historyRetentionMs);
    }
    return store.purgeOlderThan?.(historyRetentionMs) ?? 0;
  };
  const feedbackRetentionMs =
    Math.max(1, Number(process.env.FEEDBACK_RETENTION_DAYS ?? historyRetentionDays)) *
    24 *
    60 *
    60 *
    1000;
  const analysisJobRetentionMs =
    Math.max(1, Number(process.env.ANALYSIS_JOB_RETENTION_DAYS ?? 7)) *
    24 *
    60 *
    60 *
    1000;
  const purgeProductizationState = async () => {
    const feedbackRemoved = bootstrap.profile.productization?.feedbackStore.purgeOlderThan?.(
      feedbackRetentionMs,
    ) ?? 0;
    const jobsRemoved = bootstrap.profile.productization?.analysisJobs.purgeOlderThan?.(
      analysisJobRetentionMs,
    ) ?? 0;
    return { feedbackRemoved, jobsRemoved };
  };
  void purgeHistory().catch((error) =>
    console.warn("[bi-analyst] initial history purge failed", error),
  );
  void purgeProductizationState().catch((error) =>
    console.warn("[bi-analyst] initial feedback/job purge failed", error),
  );

  const retentionMs = bootstrap.profile.auditSink.retentionMs;
  const purgeIntervalMs = Number(
    process.env.AUDIT_PURGE_INTERVAL_MS ?? 60 * 60 * 1000,
  );
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  if (retentionMs != null && purgeIntervalMs > 0) {
    purgeTimer = setInterval(() => {
      void purgeAuditStoreIfConfiguredAsync(bootstrap.profile.auditSink)
        .then((count) => {
          if (count > 0) {
            console.info(`[bi-analyst] audit purge removed ${count} events`);
          }
        })
        .catch((error) => console.warn("[bi-analyst] audit purge failed", error));
      void purgeHistory().catch((error) =>
        console.warn("[bi-analyst] history purge failed", error),
      );
      void purgeProductizationState().catch((error) =>
        console.warn("[bi-analyst] feedback/job purge failed", error),
      );
    }, purgeIntervalMs);
    purgeTimer.unref?.();
  }

  const app = startAppServer(bootstrap, bootstrap.config.port);
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shutdownPromise) return shutdownPromise;
    if (purgeTimer) clearInterval(purgeTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    console.info(`[bi-analyst] ${signal} received, draining runtime`);

    const configuredTimeout = Number(
      process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000,
    );
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.max(1_000, configuredTimeout)
      : 15_000;
    const forceTimer = setTimeout(() => {
      console.error(`[bi-analyst] shutdown exceeded ${timeoutMs}ms`);
      app.server.closeAllConnections?.();
      process.exit(1);
    }, timeoutMs);

    shutdownPromise = app
      .close()
      .catch((error) => {
        process.exitCode = 1;
        console.error("[bi-analyst] graceful shutdown failed", error);
      })
      .finally(() => clearTimeout(forceTimer));
    return shutdownPromise;
  };
  const onSigint = () => void shutdown("SIGINT");
  const onSigterm = () => void shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return app;
}
