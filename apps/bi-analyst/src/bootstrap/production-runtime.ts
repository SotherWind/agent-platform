import { loadAppConfig, isLocalEnvironment } from "../config/env.js";
import { ConfigError } from "../config/env.js";
import { createProductionRuntimeProfile } from "./production-profile.js";
import {
  hydrateSqliteForSingleMachine,
  type BootstrapResult,
} from "./runtime-common.js";

/** Composition root used by the deployable production artifact. */
export function bootstrapProductionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapResult {
  const config = loadAppConfig(env);
  if (isLocalEnvironment(config.environment)) {
    throw new ConfigError(
      "The production artifact only supports APP_ENV=staging|production",
    );
  }
  const profile = createProductionRuntimeProfile(config, {}, env);
  const result = hydrateSqliteForSingleMachine(config, profile, env);
  result.readinessProbes = [];
  if (env.QDRANT_URL?.trim()) {
    result.readinessProbes.push({
      name: "qdrant",
      url: `${env.QDRANT_URL.replace(/\/$/, "")}/healthz`,
    });
  }
  if (env.POLICY_SERVICE_HEALTH_URL?.trim()) {
    result.readinessProbes.push({
      name: "policy",
      url: env.POLICY_SERVICE_HEALTH_URL,
    });
  }
  return result;
}
