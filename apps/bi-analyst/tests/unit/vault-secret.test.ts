import assert from "node:assert/strict";
import { VaultSecretProvider } from "../../src/datasource/vault-secret-provider.js";
import { createSecretProviderFromEnv } from "../../src/datasource/secrets.js";
import { AppError } from "../../src/errors/app-error.js";
import { test, section } from "../helpers/runner.js";

export async function testVaultSecretProvider() {
  section("VaultSecretProvider");

  await test("KV v2 token 读取 value 字段", async () => {
    const calls: string[] = [];
    const provider = new VaultSecretProvider({
      address: "https://vault.test",
      token: "hvs.test",
      kvMount: "secret",
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        assert.match(url, /\/v1\/secret\/data\/bi\/mysql$/);
        return new Response(
          JSON.stringify({
            data: { data: { value: "s3cret", username: "bi" } },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const secret = await provider.resolve({
      provider: "vault",
      key: "bi/mysql",
    });
    assert.equal(secret.value, "s3cret");
    assert.equal(calls.length, 1);
  });

  await test("AppRole 登录后读取 password 字段", async () => {
    let authed = false;
    const provider = new VaultSecretProvider({
      address: "https://vault.test",
      roleId: "role",
      secretId: "secret",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/auth/approle/login")) {
          assert.equal(init?.method, "POST");
          return new Response(
            JSON.stringify({
              auth: { client_token: "hvs.approle", lease_duration: 600 },
            }),
            { status: 200 },
          );
        }
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers["X-Vault-Token"], "hvs.approle");
        authed = true;
        return new Response(
          JSON.stringify({ data: { data: { password: "from-vault" } } }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const secret = await provider.resolve({
      provider: "vault",
      key: "db/pg",
    });
    assert.equal(secret.value, "from-vault");
    assert.equal(authed, true);
  });

  await test("非 vault provider 拒绝", async () => {
    const provider = new VaultSecretProvider({
      address: "https://vault.test",
      token: "t",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    await assert.rejects(
      () => provider.resolve({ provider: "env", key: "X" }),
      (err: AppError) => err.code === "config_invalid",
    );
  });

  await test("createSecretProviderFromEnv 优先 Vault", async () => {
    const provider = createSecretProviderFromEnv({
      VAULT_ADDR: "https://vault.test",
      VAULT_TOKEN: "t",
    });
    assert.equal(provider.constructor.name, "VaultSecretProvider");
  });
}
