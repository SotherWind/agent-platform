import { isLocalEnvironment, loadAppConfig } from "../config/env.js";
import { createLocalRuntimeProfile } from "./local-profile.js";
import { createProductionRuntimeProfile } from "./production-profile.js";
import {
  hydrateSqliteForSingleMachine,
  type BootstrapResult,
} from "./runtime-common.js";

export type { BootstrapResult } from "./runtime-common.js";
export {
  attachLiveDataSources,
  logBootstrapSummary,
} from "./runtime-common.js";

/** Development/test composition root. Deployable builds use production-runtime. */
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
  return hydrateSqliteForSingleMachine(config, profile, env);
}
