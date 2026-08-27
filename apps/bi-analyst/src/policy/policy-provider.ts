import fs from "node:fs";
import path from "node:path";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import { AppError } from "../errors/app-error.js";
import type { AccessPolicy } from "./access-policy.js";

/** 可插拔策略源：按主体加载 AccessPolicy */
export interface PolicyProvider {
  loadPolicy(principal: AuthenticatedPrincipal): Promise<AccessPolicy> | AccessPolicy;
  /** 当前策略版本（用于会话失效） */
  getPolicyVersion?(principal: AuthenticatedPrincipal): Promise<string> | string;
}

/** 内存策略源：按 subjectId / tenantId / 角色匹配 */
export class InMemoryPolicyProvider implements PolicyProvider {
  constructor(private readonly policies: AccessPolicy[]) {}

  loadPolicy(principal: AuthenticatedPrincipal): AccessPolicy {
    const exact = this.policies.find(
      (p) =>
        p.subjectId === principal.subjectId &&
        p.tenantId === principal.tenantId,
    );
    if (exact) {
      return { ...exact, roles: principal.roles.length ? principal.roles : exact.roles };
    }

    const byTenant = this.policies.find(
      (p) => p.tenantId === principal.tenantId && p.subjectId === "*",
    );
    if (byTenant) {
      return {
        ...byTenant,
        subjectId: principal.subjectId,
        roles: principal.roles.length ? principal.roles : byTenant.roles,
      };
    }

    throw new AppError(
      `No explicit access policy for tenant ${principal.tenantId}`,
      "forbidden",
      403,
    );
  }

  getPolicyVersion(principal: AuthenticatedPrincipal): string {
    return this.loadPolicy(principal).policyVersion;
  }
}

export interface FilePolicyDocument {
  policies: AccessPolicy[];
}

/** 从 JSON 文件加载策略（启动时读取，支持按路径热切换版本号） */
export class FilePolicyProvider implements PolicyProvider {
  private readonly inner: InMemoryPolicyProvider;
  private readonly loadedAt: string;

  constructor(filePath: string) {
    const absolute = path.resolve(filePath);
    const raw = fs.readFileSync(absolute, "utf8");
    const doc = JSON.parse(raw) as FilePolicyDocument;
    if (!Array.isArray(doc.policies)) {
      throw new Error(`策略文件缺少 policies 数组: ${absolute}`);
    }
    if (
      "defaultAllowedDataSourceIds" in doc &&
      Array.isArray((doc as Record<string, unknown>).defaultAllowedDataSourceIds)
    ) {
      throw new Error(
        `Policy file must not define a permissive defaultAllowedDataSourceIds fallback: ${absolute}`,
      );
    }
    this.inner = new InMemoryPolicyProvider(doc.policies);
    this.loadedAt = absolute;
  }

  loadPolicy(principal: AuthenticatedPrincipal): AccessPolicy {
    return this.inner.loadPolicy(principal);
  }

  getPolicyVersion(principal: AuthenticatedPrincipal): string {
    return this.inner.getPolicyVersion(principal);
  }

  get sourcePath(): string {
    return this.loadedAt;
  }
}

/** 限制数据源列表后的策略投影 */
export function withAuthorizedDataSources(
  policy: AccessPolicy,
  allowedDataSourceIds: string[],
): AccessPolicy {
  return {
    ...policy,
    allowedDataSourceIds,
  };
}
