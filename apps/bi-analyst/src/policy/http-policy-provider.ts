import type { AuthenticatedPrincipal } from "../auth/types.js";
import { AppError } from "../errors/app-error.js";
import type { AccessPolicy } from "./access-policy.js";
import type { PolicyProvider } from "./policy-provider.js";

export interface HttpPolicyProviderOptions {
  /** 策略服务基址，如 https://policy.example.com */
  baseUrl: string;
  /** GET 路径模板；`{subjectId}` `{tenantId}` 会被替换。默认 `/v1/policies/{tenantId}/{subjectId}` */
  pathTemplate?: string;
  /** 可选 Bearer / 服务间 token */
  authToken?: string;
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  /** 远端失败时的 fallback（生产通常不设，fail closed） */
  fallback?: PolicyProvider;
}

interface RemotePolicyResponse {
  policy?: AccessPolicy;
  policyVersion?: string;
  /** 部分服务把策略字段摊平在根上 */
  subjectId?: string;
  tenantId?: string;
  roles?: string[];
  allowedDataSourceIds?: string[];
  allowedTables?: string[];
  deniedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  deniedColumns?: Record<string, string[]>;
  minAggregationCount?: number;
  historyRetentionDays?: number;
  exportControls?: AccessPolicy["exportControls"];
  rowFilters?: AccessPolicy["rowFilters"];
  maskRules?: AccessPolicy["maskRules"];
  allowedSchemas?: string[];
}

/**
 * 远程策略服务客户端：HTTP GET → AccessPolicy。
 * 失败默认 fail closed；仅当显式配置 fallback 时降级。
 */
export class HttpPolicyProvider implements PolicyProvider {
  private readonly baseUrl: string;
  private readonly pathTemplate: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback?: PolicyProvider;

  constructor(options: HttpPolicyProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.pathTemplate =
      options.pathTemplate ?? "/v1/policies/{tenantId}/{subjectId}";
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallback = options.fallback;
  }

  async loadPolicy(
    principal: AuthenticatedPrincipal,
  ): Promise<AccessPolicy> {
    const path = this.pathTemplate
      .replaceAll("{subjectId}", encodeURIComponent(principal.subjectId))
      .replaceAll("{tenantId}", encodeURIComponent(principal.tenantId));
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
        };
        if (this.authToken) {
          headers.Authorization = `Bearer ${this.authToken}`;
        }
        const res = await this.fetchImpl(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new AppError(
            `策略服务返回 HTTP ${res.status}`,
            "config_invalid",
            502,
            true,
          );
        }
        const body = (await res.json()) as RemotePolicyResponse;
        return normalizeRemotePolicy(body, principal);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (this.fallback) {
        return await Promise.resolve(this.fallback.loadPolicy(principal));
      }
      if (err instanceof AppError) throw err;
      throw new AppError(
        `策略服务不可用: ${err instanceof Error ? err.message : String(err)}`,
        "config_invalid",
        502,
        true,
      );
    }
  }

  async getPolicyVersion(
    principal: AuthenticatedPrincipal,
  ): Promise<string> {
    const policy = await this.loadPolicy(principal);
    return policy.policyVersion;
  }
}

function normalizeRemotePolicy(
  body: RemotePolicyResponse,
  principal: AuthenticatedPrincipal,
): AccessPolicy {
  const base =
    body.policy ??
    ({
      subjectId: body.subjectId ?? principal.subjectId,
      tenantId: body.tenantId ?? principal.tenantId,
      policyVersion: body.policyVersion ?? "1",
      roles: body.roles ?? principal.roles,
      allowedDataSourceIds: body.allowedDataSourceIds,
      allowedSchemas: body.allowedSchemas,
      allowedTables: body.allowedTables,
      deniedTables: body.deniedTables,
      allowedColumns: body.allowedColumns,
      deniedColumns: body.deniedColumns,
      minAggregationCount: body.minAggregationCount,
      historyRetentionDays: body.historyRetentionDays,
      exportControls: body.exportControls,
      rowFilters: body.rowFilters,
      maskRules: body.maskRules,
    } as Partial<AccessPolicy>);

  if (
    !base.allowedDataSourceIds ||
    !Array.isArray(base.allowedDataSourceIds)
  ) {
    throw new AppError(
      "策略服务响应缺少 allowedDataSourceIds",
      "config_invalid",
      502,
      false,
    );
  }

  return {
    subjectId: principal.subjectId,
    tenantId: principal.tenantId,
    policyVersion: String(base.policyVersion ?? body.policyVersion ?? "1"),
    roles: principal.roles.length
      ? principal.roles
      : (base.roles ?? ["analyst"]),
    allowedDataSourceIds: base.allowedDataSourceIds,
    allowedSchemas: base.allowedSchemas,
    allowedTables: base.allowedTables,
    deniedTables: base.deniedTables,
    allowedColumns: base.allowedColumns,
    deniedColumns: base.deniedColumns,
    minAggregationCount: base.minAggregationCount,
    historyRetentionDays: base.historyRetentionDays,
    exportControls: base.exportControls,
    rowFilters: base.rowFilters,
    maskRules: base.maskRules,
  };
}

export function createHttpPolicyProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpPolicyProvider | null {
  const baseUrl = env.POLICY_SERVICE_URL;
  if (!baseUrl) return null;
  return new HttpPolicyProvider({
    baseUrl,
    pathTemplate: env.POLICY_SERVICE_PATH,
    authToken: env.POLICY_SERVICE_TOKEN,
    timeoutMs: env.POLICY_SERVICE_TIMEOUT_MS
      ? Number(env.POLICY_SERVICE_TIMEOUT_MS)
      : undefined,
  });
}
