import { createHmac, createHash } from "node:crypto";
import { AppError } from "../errors/app-error.js";
import type { ResolvedSecret, SecretReference } from "./types.js";
import type { SecretProvider } from "./secrets.js";

export interface AwsSecretsManagerProviderOptions {
  /** AWS 区域，如 ap-southeast-1 */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 可选 session token（临时凭证） */
  sessionToken?: string;
  /** 覆盖 Secrets Manager endpoint（单测 / VPC endpoint） */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * AWS Secrets Manager SecretProvider（无 SDK，SigV4 + GetSecretValue）。
 * SecretReference.key 为 SecretId（名称或 ARN）。
 * 若 SecretString 为 JSON，优先取 value / password / secret / token，否则整段字符串。
 */
export class AwsSecretsManagerProvider implements SecretProvider {
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken?: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AwsSecretsManagerProviderOptions) {
    if (!options.region) {
      throw new Error("AwsSecretsManagerProvider 需要 region");
    }
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new Error("AwsSecretsManagerProvider 需要 accessKeyId 与 secretAccessKey");
    }
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.sessionToken = options.sessionToken;
    this.endpoint =
      options.endpoint?.replace(/\/$/, "") ??
      `https://secretsmanager.${options.region}.amazonaws.com`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    if (ref.provider !== "aws-sm") {
      throw new AppError(
        `AwsSecretsManagerProvider 仅支持 aws-sm provider，收到: ${ref.provider}`,
        "config_invalid",
        500,
        false,
      );
    }

    const body: Record<string, string> = { SecretId: ref.key };
    if (ref.version) {
      // 支持 VersionId 或 VersionStage（如 AWSCURRENT）
      if (ref.version.startsWith("AW") || ref.version.includes(":")) {
        body.VersionStage = ref.version;
      } else {
        body.VersionId = ref.version;
      }
    }

    const payload = JSON.stringify(body);
    const headers = signAwsRequest({
      method: "POST",
      url: this.endpoint,
      region: this.region,
      service: "secretsmanager",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      amzTarget: "secretsmanager.GetSecretValue",
      body: payload,
    });

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: payload,
    });

    if (response.status === 400 || response.status === 404) {
      throw new AppError(
        `AWS Secrets Manager 密钥不存在: ${ref.key}`,
        "config_invalid",
        500,
        false,
      );
    }
    if (!response.ok) {
      throw new AppError(
        `AWS Secrets Manager 读取失败 (${response.status}): ${ref.key}`,
        "config_invalid",
        500,
        false,
      );
    }

    const data = (await response.json()) as {
      SecretString?: string;
      SecretBinary?: string;
    };
    const raw = data.SecretString ?? decodeBinary(data.SecretBinary);
    if (!raw) {
      throw new AppError(
        `AWS Secrets Manager 密钥为空: ${ref.key}`,
        "config_invalid",
        500,
        false,
      );
    }
    return { value: pickJsonOrRaw(raw) };
  }
}

function decodeBinary(b64?: string): string | undefined {
  if (!b64) return undefined;
  return Buffer.from(b64, "base64").toString("utf8");
}

function pickJsonOrRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["value", "password", "secret", "token"]) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
      for (const v of Object.values(obj)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
    } catch {
      /* 非 JSON，整段返回 */
    }
  }
  return raw;
}

/** 最小 SigV4 签名（Secrets Manager JSON API） */
export function signAwsRequest(input: {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  amzTarget: string;
  body: string;
  now?: Date;
}): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(input.url).host;
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": input.amzTarget,
  };
  if (input.sessionToken) {
    headers["x-amz-security-token"] = input.sessionToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k]!.trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderKeys.join(";");

  const canonicalRequest = [
    input.method,
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSignatureKey(
    input.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmacHex(signingKey, stringToSign);

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

function toAmzDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** 从环境变量装配；缺配置返回 null */
export function createAwsSecretsManagerProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): AwsSecretsManagerProvider | null {
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) return null;

  return new AwsSecretsManagerProvider({
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
    endpoint: env.AWS_SECRETS_MANAGER_ENDPOINT?.trim() || undefined,
    fetchImpl,
  });
}
