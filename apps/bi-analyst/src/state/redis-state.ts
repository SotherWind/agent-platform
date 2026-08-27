import { randomUUID } from "node:crypto";
import type { RedisCacheBackend } from "../cache/redis-query-cache.js";

export async function readRedisJson<T>(
  backend: RedisCacheBackend,
  key: string,
): Promise<T | null> {
  const raw = await backend.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    await backend.del([key]);
    return null;
  }
}

export async function writeRedisJson(
  backend: RedisCacheBackend,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const payload = JSON.stringify(value);
  if (ttlSeconds === undefined) {
    await backend.setPersistent(key, payload);
    return;
  }
  await backend.set(key, payload, Math.max(1, ttlSeconds));
}

export async function withRedisLock<T>(
  backend: RedisCacheBackend,
  key: string,
  operation: () => Promise<T>,
  options: { acquireTimeoutMs?: number; lockTtlSeconds?: number } = {},
): Promise<T> {
  const token = randomUUID();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 2_000;
  const lockTtlSeconds = options.lockTtlSeconds ?? 10;
  const deadline = Date.now() + acquireTimeoutMs;

  while (!(await backend.setIfAbsent(key, token, lockTtlSeconds))) {
    if (Date.now() >= deadline) {
      throw new Error("Persistent state is busy; retry the request");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  try {
    return await operation();
  } finally {
    await backend.compareAndDelete(key, token).catch(() => false);
  }
}

export function redisKeySegment(value: string): string {
  return encodeURIComponent(value);
}
