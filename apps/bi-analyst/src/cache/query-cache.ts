import { createHash } from "node:crypto";



export interface QueryCacheEntry<T = unknown> {

  value: T;

  createdAt: number;

  policyVersion: string;

  tenantId: string;

  subjectId: string;

  metadataVersion?: string;

}



export interface QueryCacheKeyParts {

  tenantId: string;

  subjectId: string;

  policyVersion: string;

  query: string;

  dataSourceId?: string;

  metadataVersion?: string;

  metricVersion?: string;

  clarificationChoice?: string;

  logicalQueryHash?: string;

}



/** 权限感知查询缓存：key 含 policyVersion + metadataVersion，策略/元数据变更自动 miss */

export class PermissionAwareQueryCache<T = unknown> {

  private readonly map = new Map<string, QueryCacheEntry<T>>();



  constructor(

    private readonly maxEntries = 256,

    private readonly ttlMs = 5 * 60 * 1000,

  ) {}



  static buildKey(parts: QueryCacheKeyParts): string {

    const normalized = parts.query.trim().toLowerCase().replace(/\s+/g, " ");

    const digest = createHash("sha256")

      .update(

        [

          parts.tenantId,

          parts.subjectId,

          parts.policyVersion,

          parts.dataSourceId ?? "",

          parts.metadataVersion ?? "",

          parts.metricVersion ?? "",

          parts.clarificationChoice ?? "",

          parts.logicalQueryHash ?? "",

          normalized,

        ].join("|"),

      )

      .digest("hex")

      .slice(0, 32);

    return `qc:${parts.tenantId}:${digest}`;

  }



  get(key: string, expect: QueryCacheKeyParts): T | undefined {

    const entry = this.map.get(key);

    if (!entry) return undefined;

    if (Date.now() - entry.createdAt > this.ttlMs) {

      this.map.delete(key);

      return undefined;

    }

    if (

      entry.tenantId !== expect.tenantId ||

      entry.subjectId !== expect.subjectId ||

      entry.policyVersion !== expect.policyVersion

    ) {

      this.map.delete(key);

      return undefined;

    }

    if (

      expect.metadataVersion &&

      entry.metadataVersion &&

      entry.metadataVersion !== expect.metadataVersion

    ) {

      this.map.delete(key);

      return undefined;

    }

    return entry.value;

  }



  set(key: string, parts: QueryCacheKeyParts, value: T): void {

    if (this.map.size >= this.maxEntries) {

      const oldest = this.map.keys().next().value;

      if (oldest) this.map.delete(oldest);

    }

    this.map.set(key, {

      value,

      createdAt: Date.now(),

      policyVersion: parts.policyVersion,

      tenantId: parts.tenantId,

      subjectId: parts.subjectId,

      metadataVersion: parts.metadataVersion,

    });

  }



  invalidateTenant(tenantId: string): number {

    let n = 0;

    for (const [k, v] of this.map) {

      if (v.tenantId === tenantId) {

        this.map.delete(k);

        n += 1;

      }

    }

    return n;

  }



  /** metadata alias 切换后按租户清空缓存 */

  invalidateByMetadataVersion(tenantId: string, _metadataVersion?: string): number {

    return this.invalidateTenant(tenantId);

  }



  size(): number {

    return this.map.size;

  }

}


