import { loadAppConfig } from "../config/env.js";
import type { BootstrapResult } from "./runtime-common.js";
import { createLocalRuntimeProfile } from "./local-profile.js";

/**
 * 本地 staging 演练 Profile：environment=staging，但注入本地 SQLite/HeaderAuth/
 * SchemaIndexer，无需真实 JWKS/Vault/Qdrant。用于回滚与门禁 E2E。
 */
export function bootstrapStagingE2e(): BootstrapResult {
  const config = loadAppConfig({ APP_ENV: "staging" });
  const local = createLocalRuntimeProfile({
    ...config,
    environment: "test",
  });

  return {
    config,
    profile: {
      ...local,
      environment: "staging",
      isLocal: true,
    },
    localResources: local.resources,
  };
}
