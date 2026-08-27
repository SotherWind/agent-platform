import { createHash } from "node:crypto";
import type { SecretReference, ResolvedSecret } from "./types.js";
import type { SecretProvider } from "./secrets.js";
import {
  emitAuditEvent,
  type AuditEmitter,
  getAuditEmitter,
} from "../audit/events.js";

export interface AuditingSecretProviderOptions {
  /** 审计主体占位（密钥解析常在请求外）；默认 system */
  subjectId?: string;
  tenantId?: string;
  audit?: AuditEmitter;
}

/**
 * 密钥读取 / 轮换审计钩子：包装任意 SecretProvider。
 * - `secret.resolved`：每次成功解析（metadata 不含明文）
 * - `secret.rotation_detected`：同一 key 的指纹或 version 相对上次变化
 */
export class AuditingSecretProvider implements SecretProvider {
  private readonly fingerprints = new Map<string, string>();
  private readonly versions = new Map<string, string>();
  private readonly subjectId: string;
  private readonly tenantId: string;
  private readonly audit: AuditEmitter;

  constructor(
    private readonly inner: SecretProvider,
    options: AuditingSecretProviderOptions = {},
  ) {
    this.subjectId = options.subjectId ?? "system";
    this.tenantId = options.tenantId ?? "system";
    this.audit = options.audit ?? {
      emit: (e) => emitAuditEvent(e),
    };
  }

  async resolve(ref: SecretReference): Promise<ResolvedSecret> {
    const resolved = await this.inner.resolve(ref);
    const fp = fingerprintSecret(resolved.value);
    const cacheKey = `${ref.provider}:${ref.key}`;
    const prevFp = this.fingerprints.get(cacheKey);
    const prevVersion = this.versions.get(cacheKey);
    const rotated =
      (prevFp !== undefined && prevFp !== fp) ||
      (ref.version !== undefined &&
        prevVersion !== undefined &&
        prevVersion !== ref.version);

    this.fingerprints.set(cacheKey, fp);
    if (ref.version !== undefined) {
      this.versions.set(cacheKey, ref.version);
    }

    const requestId = crypto.randomUUID();
    const traceId = requestId;
    this.audit.emit({
      event: "secret.resolved",
      requestId,
      traceId,
      subjectId: this.subjectId,
      tenantId: this.tenantId,
      metadata: {
        provider: ref.provider,
        key: ref.key,
        version: ref.version ?? null,
        fingerprint: fp.slice(0, 12),
        expiresAt: resolved.expiresAt?.toISOString() ?? null,
      },
    });

    if (rotated) {
      this.audit.emit({
        event: "secret.rotation_detected",
        requestId,
        traceId,
        subjectId: this.subjectId,
        tenantId: this.tenantId,
        metadata: {
          provider: ref.provider,
          key: ref.key,
          previousVersion: prevVersion ?? null,
          version: ref.version ?? null,
          fingerprintChanged: prevFp !== undefined && prevFp !== fp,
        },
      });
    }

    return resolved;
  }

  /** 测试/运维：清空轮换检测状态 */
  clearRotationState(): void {
    this.fingerprints.clear();
    this.versions.clear();
  }
}

function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 生产装配：对云/env 密钥提供方套审计钩子 */
export function withSecretAudit(
  provider: SecretProvider,
  options?: AuditingSecretProviderOptions,
): AuditingSecretProvider {
  if (provider instanceof AuditingSecretProvider) return provider;
  return new AuditingSecretProvider(provider, {
    ...options,
    audit: options?.audit ?? getAuditEmitter(),
  });
}
