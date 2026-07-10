import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import type { DataSourceConfig } from "./types.js";

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "forbidden" | "empty",
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface DataSourceRegistry {
  get(id: string): DataSourceConfig | undefined;
  list(): DataSourceConfig[];
  getAuthorized(
    principal: AuthenticatedPrincipal,
    policy: AccessPolicy,
  ): DataSourceConfig[];
}

export class InMemoryDataSourceRegistry implements DataSourceRegistry {
  constructor(private readonly sources: Map<string, DataSourceConfig>) {}

  static fromConfigs(configs: DataSourceConfig[]): InMemoryDataSourceRegistry {
    return new InMemoryDataSourceRegistry(
      new Map(configs.map((c) => [c.id, c])),
    );
  }

  get(id: string): DataSourceConfig | undefined {
    return this.sources.get(id);
  }

  list(): DataSourceConfig[] {
    return [...this.sources.values()];
  }

  getAuthorized(
    _principal: AuthenticatedPrincipal,
    policy: AccessPolicy,
  ): DataSourceConfig[] {
    const allowed = new Set(policy.allowedDataSourceIds);
    return this.list().filter((source) => allowed.has(source.id));
  }
}

export function requireAuthorizedDataSource(
  registry: DataSourceRegistry,
  principal: AuthenticatedPrincipal,
  policy: AccessPolicy,
  dataSourceId?: string,
): DataSourceConfig {
  const authorized = registry.getAuthorized(principal, policy);
  if (authorized.length === 0) {
    throw new RegistryError("当前主体无可用数据源", "empty");
  }

  if (dataSourceId) {
    const match = authorized.find((source) => source.id === dataSourceId);
    if (!match) {
      throw new RegistryError(`无权访问数据源 ${dataSourceId}`, "forbidden");
    }
    return match;
  }

  if (authorized.length === 1) {
    return authorized[0]!;
  }

  throw new RegistryError("存在多个数据源，需要显式选择", "forbidden");
}
