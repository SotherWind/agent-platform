import { loadAppConfig, summarizeConfig, isLocalEnvironment } from "../config/env.js";
import type { AppConfig, RuntimeProfile } from "../config/types.js";
import { summarizeEmbeddingConfig } from "../metadata/embedding-factory.js";
import {
  createLocalRuntimeProfile,
  type LocalRuntimeBundle,
} from "./local-profile.js";
import { createProductionRuntimeProfile } from "./production-profile.js";

export interface BootstrapResult {
  config: AppConfig;
  profile: RuntimeProfile;
  localResources?: LocalRuntimeBundle["resources"];
}

export function bootstrapRuntime(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapResult {
  const config = loadAppConfig(env);

  if (isLocalEnvironment(config.environment)) {
    const local = createLocalRuntimeProfile(config);
    return {
      config,
      profile: local,
      localResources: local.resources,
    };
  }

  const profile = createProductionRuntimeProfile(config, {}, env);
  return { config, profile };
}

export function logBootstrapSummary(result: BootstrapResult): void {
  console.info(
    "[bi-analyst] bootstrap",
    JSON.stringify({
      ...summarizeConfig(result.config),
      embedding: summarizeEmbeddingConfig(),
      dataSources: result.profile.dataSourceRegistry.list().map((s) => s.id),
    }),
  );
}
