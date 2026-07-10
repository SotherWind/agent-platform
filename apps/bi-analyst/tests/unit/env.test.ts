import assert from "node:assert/strict";
import {
  loadAppConfig,
  parseAppEnvironment,
  ConfigError,
  isLocalEnvironment,
} from "../../src/config/env.js";
import { test, section } from "../helpers/runner.js";

export async function testEnvConfig() {
  section("环境配置 (APP_ENV + Zod)");

  await test("APP_ENV 缺失时启动失败", () => {
    assert.throws(
      () => loadAppConfig({}),
      (err: ConfigError) => err.name === "ConfigError",
    );
  });

  await test("非法 APP_ENV 被拒绝", () => {
    assert.throws(
      () => parseAppEnvironment("local"),
      (err: ConfigError) => err.name === "ConfigError",
    );
  });

  await test("test 环境识别为本地 Profile", () => {
    const config = loadAppConfig({ APP_ENV: "test" });
    assert.equal(config.environment, "test");
    assert.equal(isLocalEnvironment(config.environment), true);
  });

  await test("production 环境不是本地 Profile", () => {
    assert.equal(isLocalEnvironment("production"), false);
  });

  await test("合法配置解析默认值", () => {
    const config = loadAppConfig({ APP_ENV: "development" });
    assert.equal(config.port, 3000);
    assert.equal(config.maxRetryCount, 3);
    assert.equal(config.configVersion, "1");
  });
}
