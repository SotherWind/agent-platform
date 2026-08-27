import type { AuditEmitter, StructuredAuditEvent } from "./events.js";
import { ConsoleAuditEmitter } from "./events.js";
import type { AuditLogger } from "./logger.js";
import { ConsoleAuditLogger } from "./logger.js";
import type { AuditStore } from "./store.js";
import { InMemoryAuditStore } from "./store.js";
import type { AuditSink } from "../config/types.js";
import { PostgresAuditStore } from "./postgres-store.js";

/** 同时写 store + 下游 emitter（如 console） */
export class StoringAuditEmitter implements AuditEmitter {
  constructor(
    private readonly store: AuditStore,
    private readonly next: AuditEmitter = new ConsoleAuditEmitter(),
  ) {}

  emit(event: Omit<StructuredAuditEvent, "timestamp">): void {
    const payload: StructuredAuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.store.append(payload);
    this.next.emit(event);
  }
}

export interface CreateLocalAuditSinkOptions {
  retentionMs?: number;
  store?: AuditStore;
}

export function createLocalAuditSink(
  options: CreateLocalAuditSinkOptions = {},
): AuditSink & { store: AuditStore } {
  const store = options.store ?? new InMemoryAuditStore();
  const emitter = new StoringAuditEmitter(store);
  const logger: AuditLogger = new ConsoleAuditLogger();
  return {
    logger,
    emitter,
    store,
    retentionMs: options.retentionMs ?? 7 * 24 * 60 * 60 * 1000,
  };
}

export interface CreateQuasiProductionAuditSinkOptions {
  connectionString: string;
  retentionMs?: number;
}

/**
 * quasi-production 审计：PostgreSQL 持久化 + console 下游。
 * staging 集群未就绪时可用 Docker PG 联调（AUDIT_DATABASE_URL）。
 */
export function createQuasiProductionAuditSink(
  options: CreateQuasiProductionAuditSinkOptions,
): AuditSink & { store: PostgresAuditStore; close: () => Promise<void> } {
  const store = new PostgresAuditStore({
    connectionString: options.connectionString,
  });
  const emitter = new StoringAuditEmitter(store);
  const logger: AuditLogger = new ConsoleAuditLogger();
  return {
    logger,
    emitter,
    store,
    retentionMs: options.retentionMs ?? 30 * 24 * 60 * 60 * 1000,
    close: () => store.close(),
  };
}

/** 解析单机审计保留天数 → ms；默认 staging/local 7 天，quasi-prod 30 天 */
export function resolveAuditRetentionMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDays = 7,
): number {
  const raw = env.AUDIT_RETENTION_DAYS?.trim();
  if (raw) {
    const days = Number(raw);
    if (Number.isFinite(days) && days >= 0) {
      return Math.floor(days * 24 * 60 * 60 * 1000);
    }
  }
  return fallbackDays * 24 * 60 * 60 * 1000;
}

export function createAuditSinkFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuditSink & { store?: AuditStore; close?: () => Promise<void> } {
  if (env.AUDIT_DATABASE_URL) {
    return createQuasiProductionAuditSink({
      connectionString: env.AUDIT_DATABASE_URL,
      retentionMs: resolveAuditRetentionMs(env, 30),
    });
  }
  return createLocalAuditSink({
    retentionMs: resolveAuditRetentionMs(env, 7),
  });
}

/** 按 retentionMs 清理；无 store/retention 时返回 0 */
export function purgeAuditStoreIfConfigured(sink: AuditSink): number {
  if (!sink.store || sink.retentionMs == null) return 0;
  return sink.store.purgeOlderThan(sink.retentionMs);
}

export async function purgeAuditStoreIfConfiguredAsync(
  sink: AuditSink,
): Promise<number> {
  if (!sink.store || sink.retentionMs == null) return 0;
  return sink.store.purgeOlderThanAsync
    ? sink.store.purgeOlderThanAsync(sink.retentionMs)
    : sink.store.purgeOlderThan(sink.retentionMs);
}
