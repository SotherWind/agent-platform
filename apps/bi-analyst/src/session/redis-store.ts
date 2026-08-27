import type { AuthenticatedPrincipal, SessionRecord } from "../auth/types.js";
import { assertSessionOwnership, AuthError } from "../auth/principal.js";
import type { RedisCacheBackend } from "../cache/redis-query-cache.js";
import {
  readRedisJson,
  redisKeySegment,
  withRedisLock,
  writeRedisJson,
} from "../state/redis-state.js";
import {
  DEFAULT_SESSION_TTL_MS,
  type SessionStore,
} from "./store.js";

interface RedisSessionEnvelope {
  record: SessionRecord;
  expiresAt: string;
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly backend: RedisCacheBackend,
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
    private readonly keyPrefix = "bi:state:v1:session:",
  ) {}

  get(): SessionRecord | null {
    throw new Error("RedisSessionStore requires getAsync()");
  }

  upsert(): SessionRecord {
    throw new Error("RedisSessionStore requires upsertAsync()");
  }

  touch(): SessionRecord {
    throw new Error("RedisSessionStore requires touchAsync()");
  }

  delete(): void {
    throw new Error("RedisSessionStore requires deleteAsync()");
  }

  purgeExpired(): number {
    return 0;
  }

  registerOrValidate(): SessionRecord {
    throw new Error("RedisSessionStore requires registerOrValidateAsync()");
  }

  async getAsync(
    tenantId: string,
    subjectId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const key = this.key(tenantId, subjectId, sessionId);
    const envelope = await readRedisJson<RedisSessionEnvelope>(this.backend, key);
    if (!envelope) return null;
    if (
      envelope.record.tenantId !== tenantId ||
      envelope.record.subjectId !== subjectId ||
      envelope.record.sessionId !== sessionId ||
      Date.parse(envelope.expiresAt) <= Date.now()
    ) {
      await this.backend.del([key]);
      return null;
    }
    return envelope.record;
  }

  async upsertAsync(record: SessionRecord): Promise<SessionRecord> {
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    await writeRedisJson(
      this.backend,
      this.key(record.tenantId, record.subjectId, record.sessionId),
      { record, expiresAt } satisfies RedisSessionEnvelope,
      Math.ceil(this.ttlMs / 1000),
    );
    return record;
  }

  async touchAsync(
    tenantId: string,
    subjectId: string,
    sessionId: string,
    policyVersion: string,
  ): Promise<SessionRecord> {
    const existing = await this.getAsync(tenantId, subjectId, sessionId);
    const now = new Date().toISOString();
    return this.upsertAsync({
      sessionId,
      tenantId,
      subjectId,
      policyVersion,
      lastDataSourceId: existing?.lastDataSourceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async deleteAsync(
    tenantId: string,
    subjectId: string,
    sessionId: string,
  ): Promise<void> {
    await this.backend.del([this.key(tenantId, subjectId, sessionId)]);
  }

  async purgeExpiredAsync(): Promise<number> {
    return 0;
  }

  async registerOrValidateAsync(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    policyVersion: string,
  ): Promise<SessionRecord> {
    const key = this.key(principal.tenantId, principal.subjectId, sessionId);
    return withRedisLock(this.backend, `${key}:lock`, async () => {
      const existing = await this.getAsync(
        principal.tenantId,
        principal.subjectId,
        sessionId,
      );
      if (!existing) {
        const now = new Date().toISOString();
        return this.upsertAsync({
          sessionId,
          tenantId: principal.tenantId,
          subjectId: principal.subjectId,
          policyVersion,
          createdAt: now,
          updatedAt: now,
        });
      }

      assertSessionOwnership(principal, existing);
      if (existing.policyVersion !== policyVersion) {
        throw new AuthError(
          "Session policy changed; start a new session",
          "policy_stale",
        );
      }
      return this.touchAsync(
        principal.tenantId,
        principal.subjectId,
        sessionId,
        policyVersion,
      );
    });
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.backend.ping?.();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }

  private key(tenantId: string, subjectId: string, sessionId: string): string {
    return [tenantId, subjectId, sessionId]
      .map(redisKeySegment)
      .join(":")
      .replace(/^/, this.keyPrefix);
  }
}
