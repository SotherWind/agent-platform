export interface TlsConnectOptions {
  /** 是否启用 TLS */
  enabled: boolean;
  /** 校验服务端证书（生产默认 true） */
  rejectUnauthorized: boolean;
  /** 可选 CA PEM */
  ca?: string;
  /** 可选客户端证书 */
  cert?: string;
  /** 可选客户端私钥 */
  key?: string;
}

export interface ResolveTlsInput {
  ssl?: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /** 生产/staging 强制校验证书 */
  requireVerified?: boolean;
}

/**
 * 解析数据源 TLS 选项。
 * - ssl=false / 未设：返回 undefined（明文）
 * - ssl=true：默认 rejectUnauthorized=true；可用 env/入参关闭（仅开发）
 */
export function resolveTlsOptions(
  input: ResolveTlsInput = {},
): TlsConnectOptions | undefined {
  if (!input.ssl) return undefined;

  const rejectUnauthorized =
    input.rejectUnauthorized ??
    (input.requireVerified === false ? false : true);

  if (input.requireVerified && !rejectUnauthorized) {
    throw new Error(
      "staging/production 禁止关闭 TLS 证书校验（rejectUnauthorized=false）",
    );
  }

  return {
    enabled: true,
    rejectUnauthorized,
    ca: input.ca,
    cert: input.cert,
    key: input.key,
  };
}

/** mysql2 ssl 配置对象 */
export function toMysqlSslConfig(
  tls: TlsConnectOptions | undefined,
): Record<string, unknown> | undefined {
  if (!tls?.enabled) return undefined;
  const cfg: Record<string, unknown> = {
    rejectUnauthorized: tls.rejectUnauthorized,
  };
  if (tls.ca) cfg.ca = tls.ca;
  if (tls.cert) cfg.cert = tls.cert;
  if (tls.key) cfg.key = tls.key;
  return cfg;
}

/** node-pg ssl 配置对象 */
export function toPostgresSslConfig(
  tls: TlsConnectOptions | undefined,
):
  | { rejectUnauthorized: boolean; ca?: string; cert?: string; key?: string }
  | undefined {
  if (!tls?.enabled) return undefined;
  const cfg: {
    rejectUnauthorized: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  } = {
    rejectUnauthorized: tls.rejectUnauthorized,
  };
  if (tls.ca) cfg.ca = tls.ca;
  if (tls.cert) cfg.cert = tls.cert;
  if (tls.key) cfg.key = tls.key;
  return cfg;
}
