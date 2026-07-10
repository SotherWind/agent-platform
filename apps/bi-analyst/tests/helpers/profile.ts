import { bootstrapRuntime, type BootstrapResult } from "../../src/bootstrap/index.js";

let cached: BootstrapResult | null = null;

export function getTestBootstrap(): BootstrapResult {
  if (!cached) {
    process.env.APP_ENV ??= "test";
    cached = bootstrapRuntime();
  }
  return cached;
}

export function getTestRuntimeProfile() {
  return getTestBootstrap().profile;
}

export function getTestDb() {
  const bootstrap = getTestBootstrap();
  if (!bootstrap.localResources) {
    throw new Error("test bootstrap 缺少本地数据库资源");
  }
  return bootstrap.localResources.db;
}
