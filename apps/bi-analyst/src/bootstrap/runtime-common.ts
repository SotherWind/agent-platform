import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { summarizeConfig } from "../config/env.js";
import type { AppConfig, RuntimeProfile } from "../config/types.js";
import { summarizeEmbeddingConfig } from "../metadata/embedding-factory.js";
import {
  attachLiveExecutors,
  buildSqliteExecutorRegistry,
  mergeDataSourceConfigs,
} from "../datasource/executor-factory.js";
import { createExecutorRegistry } from "../datasource/executor-registry.js";
import { createSqliteDataSourceConfig } from "../datasource/types.js";
import { openSqliteDatabase } from "../db/sqlite.js";
import { isSingleMachineStaging } from "./production-profile.js";

export interface BootstrapResult {
  config: AppConfig;
  profile: RuntimeProfile;
  localResources?: {
    db: Database.Database;
    dbPath: string;
  };
  liveDataSourceIds?: string[];
  readinessProbes?: Array<{ name: string; url: string }>;
}

/** Attach an existing operator-managed SQLite database without seeding it. */
export function hydrateSqliteForSingleMachine(
  config: AppConfig,
  profile: RuntimeProfile,
  env: NodeJS.ProcessEnv,
): BootstrapResult {
  if (!isSingleMachineStaging(config, env)) {
    return { config, profile };
  }

  const sqlite = profile.dataSourceRegistry
    .list()
    .find((source) => source.dialectFamily === "sqlite");
  const filePath = sqlite?.connection.filePath ?? "";
  if (!filePath) return { config, profile };

  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return { config, profile };

  const db = openSqliteDatabase(resolved, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only = ON");
  const dataSourceId = sqlite!.id;
  const sourceConfig = createSqliteDataSourceConfig(dataSourceId, resolved);
  const executorRegistry = buildSqliteExecutorRegistry({
    db,
    dataSourceId,
    config: sourceConfig,
  });

  const existing = profile.executorRegistry;
  if (existing) {
    for (const id of existing.listIds()) {
      const executor = existing.tryResolve(id);
      if (executor && id !== dataSourceId) executorRegistry.register(id, executor);
    }
  }
  profile.executorRegistry = executorRegistry;

  return {
    config,
    profile,
    localResources: { db, dbPath: resolved },
  };
}

export async function attachLiveDataSources(
  result: BootstrapResult,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  if (env.BI_ATTACH_LIVE_DATASOURCES !== "1") return result;

  const allowed =
    result.profile.isLocal ||
    result.config.environment === "staging" ||
    env.BI_ATTACH_LIVE_ON_STAGING === "1";
  if (!allowed) return result;

  let registry = result.profile.executorRegistry;
  if (!registry) {
    registry = createExecutorRegistry([]);
    result.profile.executorRegistry = registry;
  }

  const attached = await attachLiveExecutors(registry, {
    dataSourceRegistry: result.profile.dataSourceRegistry,
    secretProvider: result.profile.secretProvider,
    environment: result.config.environment,
    poolMax: result.config.deployment.datasourcePoolMax,
    tenantConcurrencyMax: result.config.deployment.tenantConcurrencyMax,
  });
  if (attached.dataSourceConfigs.length === 0) {
    return { ...result, liveDataSourceIds: [] };
  }

  result.profile.dataSourceRegistry = mergeDataSourceConfigs(
    result.profile.dataSourceRegistry,
    attached.dataSourceConfigs,
  );
  return { ...result, liveDataSourceIds: attached.attached };
}

export function logBootstrapSummary(result: BootstrapResult): void {
  console.info(
    "[bi-analyst] bootstrap",
    JSON.stringify({
      ...summarizeConfig(result.config),
      embedding: summarizeEmbeddingConfig(),
      dataSources: result.profile.dataSourceRegistry.list().map((source) => source.id),
      executors: result.profile.executorRegistry?.listIds() ?? [],
      liveDataSourceIds: result.liveDataSourceIds ?? [],
    }),
  );
}
