import assert from "node:assert/strict";
import {
  AwsSecretsManagerProvider,
  createAwsSecretsManagerProviderFromEnv,
  signAwsRequest,
} from "../../src/datasource/aws-secret-provider.js";
import {
  AzureKeyVaultProvider,
  createAzureKeyVaultProviderFromEnv,
} from "../../src/datasource/azure-secret-provider.js";
import {
  CompositeSecretProvider,
  createCloudSecretProviderFromEnv,
  createSecretProviderFromEnv,
} from "../../src/datasource/secrets.js";
import { AppError } from "../../src/errors/app-error.js";
import { test, section } from "../helpers/runner.js";

export async function testCloudSecretProviders() {
  section("AWS / Azure SecretProvider");

  await test("AWS SigV4 生成 Authorization", () => {
    const headers = signAwsRequest({
      method: "POST",
      url: "https://secretsmanager.ap-southeast-1.amazonaws.com",
      region: "ap-southeast-1",
      service: "secretsmanager",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzTarget: "secretsmanager.GetSecretValue",
      body: '{"SecretId":"bi/mysql"}',
      now: new Date("2020-01-01T00:00:00Z"),
    });
    assert.match(headers.authorization!, /^AWS4-HMAC-SHA256 Credential=/);
    assert.equal(headers["x-amz-target"], "secretsmanager.GetSecretValue");
    assert.equal(headers["x-amz-date"], "20200101T000000Z");
  });

  await test("AWS Secrets Manager 读取 JSON password", async () => {
    const provider = new AwsSecretsManagerProvider({
      region: "ap-southeast-1",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      fetchImpl: (async (_input, init) => {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body)) as { SecretId: string };
        assert.equal(body.SecretId, "bi/mysql");
        return new Response(
          JSON.stringify({
            SecretString: JSON.stringify({ password: "aws-pass" }),
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const secret = await provider.resolve({
      provider: "aws-sm",
      key: "bi/mysql",
    });
    assert.equal(secret.value, "aws-pass");
  });

  await test("Azure Key Vault OAuth + 读取密钥", async () => {
    const calls: string[] = [];
    const provider = new AzureKeyVaultProvider({
      vaultName: "bi-vault",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl: (async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("login.microsoftonline.com")) {
          return new Response(
            JSON.stringify({ access_token: "atok", expires_in: 3600 }),
            { status: 200 },
          );
        }
        assert.match(url, /bi-vault\.vault\.azure\.net\/secrets\/db-pass/);
        return new Response(JSON.stringify({ value: "azure-pass" }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    const secret = await provider.resolve({
      provider: "azure-kv",
      key: "db-pass",
    });
    assert.equal(secret.value, "azure-pass");
    assert.equal(calls.length, 2);
  });

  await test("非匹配 provider 拒绝", async () => {
    const aws = new AwsSecretsManagerProvider({
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "b",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    await assert.rejects(
      () => aws.resolve({ provider: "vault", key: "x" }),
      (err: AppError) => err.code === "config_invalid",
    );
  });

  await test("create*FromEnv 缺配置返回 null", () => {
    assert.equal(createAwsSecretsManagerProviderFromEnv({}), null);
    assert.equal(createAzureKeyVaultProviderFromEnv({}), null);
    assert.equal(createCloudSecretProviderFromEnv({}), null);
  });

  await test("多云装配 CompositeSecretProvider", async () => {
    const provider = createSecretProviderFromEnv({
      VAULT_ADDR: "https://vault.test",
      VAULT_TOKEN: "t",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "a",
      AWS_SECRET_ACCESS_KEY: "b",
    });
    assert.equal(provider.constructor.name, "CompositeSecretProvider");
    const composite = provider as CompositeSecretProvider;
    assert.ok(composite.has("vault"));
    assert.ok(composite.has("aws-sm"));
  });
}
