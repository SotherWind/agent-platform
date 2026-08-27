export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export interface RateLimitScope {
  subjectId?: string;
  endpoint?: string;
}

export interface DistributedRateLimitBackend {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

/** 固定窗口租户限流（API 层） */
export class TenantRateLimiter {
  private readonly windows = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(
    protected readonly maxPerWindow = 60,
    protected readonly windowMs = 60_000,
  ) {}

  check(tenantId: string, scope?: RateLimitScope): RateLimitResult {
    const key = rateLimitKey(tenantId, scope);
    const now = Date.now();
    let bucket = this.windows.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.windows.set(key, bucket);
    }
    if (bucket.count >= this.maxPerWindow) {
      const retryAfterMs = this.windowMs - (now - bucket.windowStart);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.maxPerWindow - bucket.count,
    };
  }

  async checkAsync(tenantId: string, scope?: RateLimitScope): Promise<RateLimitResult> {
    return this.check(tenantId, scope);
  }

  reset(tenantId?: string): void {
    if (tenantId) {
      for (const key of this.windows.keys()) {
        if (key === tenantId || key.startsWith(`${tenantId}|`)) this.windows.delete(key);
      }
    }
    else this.windows.clear();
  }
}

/** Redis-backed fixed-window limiter for multi-instance deployments. */
export class RedisTenantRateLimiter extends TenantRateLimiter {
  constructor(
    private readonly backend: DistributedRateLimitBackend,
    maxPerWindow = 60,
    windowMs = 60_000,
    private readonly namespace = "bi:rl:v1:",
  ) {
    super(maxPerWindow, windowMs);
  }

  override async checkAsync(
    tenantId: string,
    scope?: RateLimitScope,
  ): Promise<RateLimitResult> {
    const key = `${this.namespace}${rateLimitKey(tenantId, scope)}`;
    const count = await this.backend.incr(key);
    if (count === 1) {
      await this.backend.expire(key, Math.ceil(this.windowMs / 1000));
    }
    if (count > this.maxPerWindow) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: this.windowMs,
      };
    }
    return {
      allowed: true,
      remaining: Math.max(0, this.maxPerWindow - count),
    };
  }
}

function rateLimitKey(tenantId: string, scope?: RateLimitScope): string {
  return [tenantId, scope?.subjectId ?? "*", scope?.endpoint ?? "*"]
    .map((part) => encodeURIComponent(part))
    .join("|");
}
