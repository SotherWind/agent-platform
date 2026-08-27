import {
  PermissionAwareQueryCache,
  type QueryCacheKeyParts,
} from "./query-cache.js";

/** 可注入的 Redis 后端（单测用内存实现；生产用 RESP 客户端） */
export interface RedisCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setPersistent(key: string, value: string): Promise<void>;
  setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  compareAndDelete(key: string, expectedValue: string): Promise<boolean>;
  del(keys: string[]): Promise<number>;
  scan(pattern: string): Promise<string[]>;
  ping?(): Promise<void>;
  close?(): Promise<void>;
  incr?(key: string): Promise<number>;
  expire?(key: string, seconds: number): Promise<void>;
}

export interface RedisPermissionAwareQueryCacheOptions {
  backend: RedisCacheBackend;
  maxEntries?: number;
  ttlMs?: number;
  /** Redis key 前缀 */
  keyPrefix?: string;
}

/**
 * 权限感知查询缓存 L1(内存) + L2(Redis 写穿)。
 * 同步 API 与 PermissionAwareQueryCache 一致；跨实例靠 L2 最终一致。
 */
export class RedisPermissionAwareQueryCache<
  T = unknown,
> extends PermissionAwareQueryCache<T> {
  private readonly backend: RedisCacheBackend;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private pending = Promise.resolve();

  constructor(options: RedisPermissionAwareQueryCacheOptions) {
    super(options.maxEntries ?? 256, options.ttlMs ?? 5 * 60 * 1000);
    this.backend = options.backend;
    this.keyPrefix = options.keyPrefix ?? "bi:qc:v1:";
    this.ttlSeconds = Math.max(
      1,
      Math.ceil((options.ttlMs ?? 5 * 60 * 1000) / 1000),
    );
  }

  private redisKey(cacheKey: string): string {
    return `${this.keyPrefix}${cacheKey}`;
  }

  private enqueue(task: () => Promise<void>): void {
    this.pending = this.pending.then(task).catch(() => {});
  }

  override set(key: string, parts: QueryCacheKeyParts, value: T): void {
    super.set(key, parts, value);
    const payload = JSON.stringify({
      value,
      createdAt: Date.now(),
      policyVersion: parts.policyVersion,
      tenantId: parts.tenantId,
      subjectId: parts.subjectId,
      metadataVersion: parts.metadataVersion,
    });
    this.enqueue(async () => {
      await this.backend.set(this.redisKey(key), payload, this.ttlSeconds);
    });
  }

  override get(key: string, expect: QueryCacheKeyParts): T | undefined {
    const hit = super.get(key, expect);
    if (hit !== undefined) return hit;
    // 异步从 L2 回填，本请求仍 miss（与 PostgresAuditStore 同步合约一致）
    this.enqueue(async () => {
      const raw = await this.backend.get(this.redisKey(key));
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as {
          value: T;
          policyVersion: string;
          tenantId: string;
          subjectId: string;
          metadataVersion?: string;
        };
        if (
          parsed.tenantId !== expect.tenantId ||
          parsed.subjectId !== expect.subjectId ||
          parsed.policyVersion !== expect.policyVersion ||
          (parsed.metadataVersion ?? "") !== (expect.metadataVersion ?? "")
        ) {
          return;
        }
        super.set(key, expect, parsed.value);
      } catch {
        // ignore corrupt
      }
    });
    return undefined;
  }

  async getAsync(
    key: string,
    expect: QueryCacheKeyParts,
  ): Promise<T | undefined> {
    const hit = super.get(key, expect);
    if (hit !== undefined) return hit;
    const raw = await this.backend.get(this.redisKey(key));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as {
      value: T;
      policyVersion: string;
      tenantId: string;
      subjectId: string;
      metadataVersion?: string;
    };
      if (
        parsed.tenantId !== expect.tenantId ||
        parsed.subjectId !== expect.subjectId ||
        parsed.policyVersion !== expect.policyVersion ||
        (parsed.metadataVersion ?? "") !== (expect.metadataVersion ?? "")
      ) {
        return undefined;
      }
      super.set(key, expect, parsed.value);
      return parsed.value;
    } catch {
      return undefined;
    }
  }

  override invalidateTenant(tenantId: string): number {
    const n = super.invalidateTenant(tenantId);
    this.enqueue(async () => {
      const pattern = `${this.keyPrefix}qc:${tenantId}:*`;
      const keys = await this.backend.scan(pattern);
      if (keys.length > 0) await this.backend.del(keys);
    });
    return n;
  }

  override invalidateByMetadataVersion(tenantId: string, _metadataVersion?: string): number {
    return this.invalidateTenant(tenantId);
  }

  /** 等待后台 Redis 写穿完成（单测用） */
  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.backend.close?.();
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.backend.ping?.();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }
}

/** 单测 / 无 Redis 时的内存后端 */
export class InMemoryRedisCacheBackend implements RedisCacheBackend {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async setPersistent(key: string, value: string): Promise<void> {
    this.map.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const existing = this.map.get(key);
    if (existing && existing.expiresAt > Date.now()) return false;
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    const existing = this.map.get(key);
    if (!existing || existing.expiresAt <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    if (existing.value !== expectedValue) return false;
    this.map.delete(key);
    return true;
  }

  async del(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.map.delete(k)) n += 1;
    }
    return n;
  }

  async scan(pattern: string): Promise<string[]> {
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    const now = Date.now();
    const out: string[] = [];
    for (const [k, v] of this.map) {
      if (v.expiresAt < now) {
        this.map.delete(k);
        continue;
      }
      if (regex.test(k)) out.push(k);
    }
    return out;
  }

  size(): number {
    return this.map.size;
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? "0") + 1;
    await this.set(key, String(current), 86_400);
    return current;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.map.get(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
  }

  async ping(): Promise<void> {}
}

/**
 * 最小 Redis RESP 客户端（仅 GET/SET EX/DEL/KEYS）。
 * 避免引入额外依赖；REDIS_URL=redis://host:6379
 */
export class RespRedisCacheBackend implements RedisCacheBackend {
  private socket: import("node:net").Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: Array<{
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
    expect: number;
  }> = [];
  private connecting: Promise<void> | null = null;

  constructor(private readonly url: string) {}

  private async ensureConnected(): Promise<import("node:net").Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    if (!this.socket) throw new Error("Redis 连接失败");
    return this.socket;
  }

  private async connect(): Promise<void> {
    const net = await import("node:net");
    const parsed = new URL(this.url);
    const host = parsed.hostname || "127.0.0.1";
    const port = Number(parsed.port || 6379);
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;
    const db =
      parsed.pathname && parsed.pathname !== "/"
        ? Number(parsed.pathname.slice(1))
        : 0;

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => resolve());
      socket.once("error", reject);
      this.socket = socket;
      socket.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        this.onData(buf);
      });
      socket.on("close", () => {
        this.socket = null;
      });
    });

    if (password) {
      await this.command(["AUTH", password]);
    }
    if (db > 0) {
      await this.command(["SELECT", String(db)]);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.queue.length > 0) {
      const parsed = tryParseResp(this.buffer, this.queue[0]!.expect);
      if (!parsed) break;
      this.buffer = Buffer.from(parsed.rest);
      const item = this.queue.shift()!;
      if (parsed.error) item.reject(new Error(parsed.error));
      else item.resolve(parsed.values);
    }
  }

  private command(args: string[]): Promise<string[]> {
    return new Promise(async (resolve, reject) => {
      try {
        const socket = await this.ensureConnected();
        const expect = args[0]?.toUpperCase() === "SCAN" ? -2 : 1;
        this.queue.push({ resolve, reject, expect });
        socket.write(encodeResp(args));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command(["GET", key]);
    const v = result[0];
    return v === null || v === undefined || v === "" ? null : v;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.command(["SET", key, value, "EX", String(ttlSeconds)]);
  }

  async setPersistent(key: string, value: string): Promise<void> {
    await this.command(["SET", key, value]);
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.command([
      "SET",
      key,
      value,
      "NX",
      "EX",
      String(ttlSeconds),
    ]);
    return result[0] === "OK";
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      "1",
      key,
      expectedValue,
    ]);
    return Number(result[0] ?? 0) === 1;
  }

  async incr(key: string): Promise<number> {
    const result = await this.command(["INCR", key]);
    return Number(result[0] ?? 0);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.command(["EXPIRE", key, String(seconds)]);
  }

  async del(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const result = await this.command(["DEL", ...keys]);
    return Number(result[0] ?? 0);
  }

  async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const result = await this.command([
        "SCAN",
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "1000",
      ]);
      cursor = result[0] ?? "0";
      keys.push(...result.slice(1));
    } while (cursor !== "0");
    return keys;
  }

  async ping(): Promise<void> {
    await this.command(["PING"]);
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}

function encodeResp(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const buf = Buffer.from(arg, "utf8");
    out += `$${buf.length}\r\n${arg}\r\n`;
  }
  return out;
}

function tryParseResp(
  buffer: Buffer,
  expect: number,
): { values: string[]; rest: Buffer; error?: string } | null {
  if (expect === -2) return tryParseScanResp(buffer);
  const text = buffer.toString("utf8");
  if (!text.includes("\r\n")) return null;

  // 简化解析：覆盖 bulk string / simple string / integer / array / null / error
  if (text.startsWith("-")) {
    const end = text.indexOf("\r\n");
    if (end < 0) return null;
    return {
      values: [],
      rest: buffer.subarray(end + 2),
      error: text.slice(1, end),
    };
  }

  if (text.startsWith("*")) {
    const headerEnd = text.indexOf("\r\n");
    if (headerEnd < 0) return null;
    const count = Number(text.slice(1, headerEnd));
    if (Number.isNaN(count)) return null;
    if (count < 0) {
      return { values: [], rest: buffer.subarray(headerEnd + 2) };
    }
    let offset = headerEnd + 2;
    const values: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const item = parseOne(buffer.subarray(offset));
      if (!item) return null;
      values.push(item.value ?? "");
      offset += item.consumed;
    }
    return { values, rest: buffer.subarray(offset) };
  }

  const one = parseOne(buffer);
  if (!one) return null;
  if (expect > 1) return null;
  return {
    values: [one.value ?? ""],
    rest: buffer.subarray(one.consumed),
  };
}

function tryParseScanResp(
  buffer: Buffer,
): { values: string[]; rest: Buffer; error?: string } | null {
  const parsed = parseNestedResp(buffer);
  if (!parsed) return null;
  if (parsed.error) {
    return { values: [], rest: buffer.subarray(parsed.consumed), error: parsed.error };
  }
  const value = parsed.value;
  if (!Array.isArray(value)) return null;
  const cursor = typeof value[0] === "string" ? value[0] : "0";
  const keys = Array.isArray(value[1])
    ? value[1].filter((item): item is string => typeof item === "string")
    : [];
  return { values: [cursor, ...keys], rest: buffer.subarray(parsed.consumed) };
}

function parseNestedResp(
  buffer: Buffer,
  offset = 0,
): { value: unknown; consumed: number; error?: string } | null {
  const prefix = buffer[offset];
  if (prefix === undefined) return null;
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  if (prefix === 45) {
    return {
      value: null,
      consumed: lineEnd + 2 - offset,
      error: buffer.subarray(offset + 1, lineEnd).toString("utf8"),
    };
  }
  if (prefix === 43 || prefix === 58) {
    return {
      value: buffer.subarray(offset + 1, lineEnd).toString("utf8"),
      consumed: lineEnd + 2 - offset,
    };
  }
  if (prefix === 36) {
    const length = Number(buffer.subarray(offset + 1, lineEnd).toString("utf8"));
    if (length < 0) return { value: null, consumed: lineEnd + 2 - offset };
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    return {
      value: buffer.subarray(start, end).toString("utf8"),
      consumed: end + 2 - offset,
    };
  }
  if (prefix === 42) {
    const count = Number(buffer.subarray(offset + 1, lineEnd).toString("utf8"));
    if (count < 0) return { value: null, consumed: lineEnd + 2 - offset };
    const items: unknown[] = [];
    let cursor = lineEnd + 2;
    for (let i = 0; i < count; i += 1) {
      const child = parseNestedResp(buffer, cursor);
      if (!child) return null;
      if (child.error) return child;
      items.push(child.value);
      cursor += child.consumed;
    }
    return { value: items, consumed: cursor - offset };
  }
  return null;
}

function parseOne(
  buffer: Buffer,
): { value: string | null; consumed: number } | null {
  const text = buffer.toString("utf8");
  if (text.startsWith("$-1\r\n")) {
    return { value: null, consumed: 5 };
  }
  if (text.startsWith("$")) {
    const headerEnd = text.indexOf("\r\n");
    if (headerEnd < 0) return null;
    const len = Number(text.slice(1, headerEnd));
    if (Number.isNaN(len) || len < 0) return null;
    const start = headerEnd + 2;
    const end = start + len;
    if (buffer.length < end + 2) return null;
    return {
      value: buffer.subarray(start, end).toString("utf8"),
      consumed: end + 2,
    };
  }
  if (text.startsWith("+") || text.startsWith(":")) {
    const end = text.indexOf("\r\n");
    if (end < 0) return null;
    return { value: text.slice(1, end), consumed: end + 2 };
  }
  return null;
}

export function createQueryCacheFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { maxEntries?: number; ttlMs?: number } = {},
): PermissionAwareQueryCache {
  const maxEntries = options.maxEntries ?? 256;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    return new PermissionAwareQueryCache(maxEntries, ttlMs);
  }
  return new RedisPermissionAwareQueryCache({
    backend: new RespRedisCacheBackend(redisUrl),
    maxEntries,
    ttlMs,
  });
}
