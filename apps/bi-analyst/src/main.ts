import dotenv from "dotenv";
import {
  ensureStagingMockAuth,
  isStagingMockAuthEnabled,
} from "./auth/staging-mock-auth.js";
import { bootstrapProductionRuntime } from "./bootstrap/production-runtime.js";
import { attachLiveDataSources } from "./bootstrap/runtime-common.js";
import { startRuntime } from "./runtime/start.js";

dotenv.config();

async function prepareStagingMockAuth(): Promise<void> {
  if (
    process.env.APP_ENV === "production" &&
    process.env.BI_STAGING_MOCK_AUTH === "1"
  ) {
    throw new Error("BI_STAGING_MOCK_AUTH is forbidden in production");
  }
  if (!isStagingMockAuthEnabled(process.env)) return;
  const mock = await ensureStagingMockAuth({
    issuer: process.env.AUTH_ISSUER?.trim() || undefined,
    audience: process.env.AUTH_AUDIENCE?.trim() || undefined,
  });
  process.env.AUTH_JWKS_JSON ||= JSON.stringify(mock.jwks);
  process.env.AUTH_ISSUER ||= mock.issuer;
  process.env.AUTH_AUDIENCE ||= mock.audience;
}

async function main(): Promise<void> {
  await prepareStagingMockAuth();
  const bootstrap = await attachLiveDataSources(bootstrapProductionRuntime());
  await startRuntime(bootstrap);
}

void main().catch((error) => {
  console.error("[bi-analyst] startup failed", error);
  process.exit(1);
});
