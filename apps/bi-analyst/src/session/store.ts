import type Database from "better-sqlite3";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { SessionRecord } from "../auth/types.js";
import { assertSessionOwnership, AuthError } from "../auth/principal.js";

export interface SessionStore {
  get(
    tenantId: string,
    subjectId: string,
    sessionId: string,
  ): SessionRecord | null;
  upsert(record: SessionRecord): SessionRecord;
  touch(
    tenantId: string,
    subjectId: string,
    sessionId: string,
    policyVersion: string,
  ): SessionRecord;
  delete(tenantId: string, subjectId: string, sessionId: string): void;
  purgeExpired(now?: Date): number;
  registerOrValidate(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    policyVersion: string,
  ): SessionRecord;
}

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function initSessionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      tenant_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      last_data_source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, subject_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_expires
      ON agent_sessions(expires_at);
  `);
}

function rowToRecord(row: Record<string, unknown>): SessionRecord {
  return {
    sessionId: String(row.session_id),
    tenantId: String(row.tenant_id),
    subjectId: String(row.subject_id),
    policyVersion: String(row.policy_version),
    lastDataSourceId: row.last_data_source_id
      ? String(row.last_data_source_id)
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
  ) {
    initSessionSchema(db);
  }

  get(
    tenantId: string,
    subjectId: string,
    sessionId: string,
  ): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE tenant_id = ? AND subject_id = ? AND session_id = ?`,
      )
      .get(tenantId, subjectId, sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const expiresAt = Date.parse(String(row.expires_at));
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      this.delete(tenantId, subjectId, sessionId);
      return null;
    }

    return rowToRecord(row);
  }

  upsert(record: SessionRecord): SessionRecord {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    this.db
      .prepare(
        `INSERT INTO agent_sessions (
          tenant_id, subject_id, session_id, policy_version,
          last_data_source_id, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, subject_id, session_id) DO UPDATE SET
          policy_version = excluded.policy_version,
          last_data_source_id = COALESCE(excluded.last_data_source_id, agent_sessions.last_data_source_id),
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at`,
      )
      .run(
        record.tenantId,
        record.subjectId,
        record.sessionId,
        record.policyVersion,
        record.lastDataSourceId ?? null,
        record.createdAt,
        record.updatedAt,
        expiresAt.toISOString(),
      );
    return record;
  }

  touch(
    tenantId: string,
    subjectId: string,
    sessionId: string,
    policyVersion: string,
  ): SessionRecord {
    const existing = this.get(tenantId, subjectId, sessionId);
    const now = new Date().toISOString();
    return this.upsert({
      sessionId,
      tenantId,
      subjectId,
      policyVersion,
      lastDataSourceId: existing?.lastDataSourceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  delete(tenantId: string, subjectId: string, sessionId: string): void {
    this.db
      .prepare(
        `DELETE FROM agent_sessions
         WHERE tenant_id = ? AND subject_id = ? AND session_id = ?`,
      )
      .run(tenantId, subjectId, sessionId);
  }

  purgeExpired(now = new Date()): number {
    const result = this.db
      .prepare(`DELETE FROM agent_sessions WHERE expires_at <= ?`)
      .run(now.toISOString());
    return result.changes;
  }

  registerOrValidate(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    policyVersion: string,
  ): SessionRecord {
    const existing = this.get(
      principal.tenantId,
      principal.subjectId,
      sessionId,
    );

    if (!existing) {
      const now = new Date().toISOString();
      return this.upsert({
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
        "权限策略已变更，请开启新会话",
        "policy_stale",
      );
    }

    return this.touch(
      principal.tenantId,
      principal.subjectId,
      sessionId,
      policyVersion,
    );
  }
}

/** 内存 SessionStore：单元测试用 */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_SESSION_TTL_MS) {}

  private key(tenantId: string, subjectId: string, sessionId: string): string {
    return `${tenantId}:${subjectId}:${sessionId}`;
  }

  get(
    tenantId: string,
    subjectId: string,
    sessionId: string,
  ): SessionRecord | null {
    const k = this.key(tenantId, subjectId, sessionId);
    const exp = this.expiresAt.get(k);
    if (exp !== undefined && exp <= Date.now()) {
      this.delete(tenantId, subjectId, sessionId);
      return null;
    }
    return this.records.get(k) ?? null;
  }

  upsert(record: SessionRecord): SessionRecord {
    const k = this.key(record.tenantId, record.subjectId, record.sessionId);
    this.records.set(k, record);
    this.expiresAt.set(k, Date.now() + this.ttlMs);
    return record;
  }

  touch(
    tenantId: string,
    subjectId: string,
    sessionId: string,
    policyVersion: string,
  ): SessionRecord {
    const existing = this.get(tenantId, subjectId, sessionId);
    const now = new Date().toISOString();
    return this.upsert({
      sessionId,
      tenantId,
      subjectId,
      policyVersion,
      lastDataSourceId: existing?.lastDataSourceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  delete(tenantId: string, subjectId: string, sessionId: string): void {
    const k = this.key(tenantId, subjectId, sessionId);
    this.records.delete(k);
    this.expiresAt.delete(k);
  }

  purgeExpired(now = new Date()): number {
    let count = 0;
    for (const [k, exp] of this.expiresAt.entries()) {
      if (exp <= now.getTime()) {
        this.records.delete(k);
        this.expiresAt.delete(k);
        count += 1;
      }
    }
    return count;
  }

  registerOrValidate(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    policyVersion: string,
  ): SessionRecord {
    const existing = this.get(
      principal.tenantId,
      principal.subjectId,
      sessionId,
    );

    if (!existing) {
      const now = new Date().toISOString();
      return this.upsert({
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
        "权限策略已变更，请开启新会话",
        "policy_stale",
      );
    }

    return this.touch(
      principal.tenantId,
      principal.subjectId,
      sessionId,
      policyVersion,
    );
  }
}
