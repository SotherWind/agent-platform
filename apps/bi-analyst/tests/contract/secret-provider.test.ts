import assert from "node:assert/strict";
import {
  EnvSecretProvider,
  TestSecretProvider,
  type SecretProvider,
} from "../../src/datasource/secrets.js";
import { test, section } from "../helpers/runner.js";

/** 所有 SecretProvider 实现必须通过的 contract 行为 */
async function runSecretProviderContract(
  label: string,
  factory: () => { provider: SecretProvider; cleanup?: () => void },
  resolveRef: { provider: "test" | "env"; key: string },
) {
  section(`Contract: SecretProvider (${label})`);

  await test("resolve 返回已配置的密钥", async () => {
    const { provider, cleanup } = factory();
    try {
      const result = await provider.resolve(resolveRef);
      assert.equal(result.value, "secret-value");
    } finally {
      cleanup?.();
    }
  });

  await test("缺失密钥时抛出错误", async () => {
    const { provider, cleanup } = factory();
    try {
      await assert.rejects(
        () =>
          provider.resolve({
            provider: resolveRef.provider,
            key: "MISSING_KEY",
          }),
        /未配置|未设置/,
      );
    } finally {
      cleanup?.();
    }
  });
}

export async function testSecretProviderContract() {
  await runSecretProviderContract(
    "TestSecretProvider",
    () => ({
      provider: new TestSecretProvider({ TEST_KEY: "secret-value" }),
    }),
    { provider: "test", key: "TEST_KEY" },
  );

  const envKey = "BI_CONTRACT_SECRET";
  await runSecretProviderContract(
    "EnvSecretProvider",
    () => {
      process.env[envKey] = "secret-value";
      return {
        provider: new EnvSecretProvider(),
        cleanup: () => {
          delete process.env[envKey];
        },
      };
    },
    { provider: "env", key: envKey },
  );
}
