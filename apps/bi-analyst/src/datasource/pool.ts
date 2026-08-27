export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetMs?: number;
}

type CircuitState = "closed" | "open" | "half_open";

/** 简单熔断器：连续失败后短路，超时后半开试探 */
export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = "closed";
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetMs = options.resetMs ?? 30_000;
  }

  getStatus(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === "open") {
      throw new Error("熔断器开启：数据源暂时不可用");
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private maybeHalfOpen(): void {
    if (
      this.state === "open" &&
      Date.now() - this.openedAt >= this.resetMs
    ) {
      this.state = "half_open";
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold || this.state === "half_open") {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

export interface PoolStats {
  active: number;
  idle: number;
  waiting: number;
}

/** 租户级并发配额（防止慢源拖垮全局） */
export class TenantConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerTenant: number = 8) {}

  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.active.get(tenantId) ?? 0;
    if (current >= this.maxPerTenant) {
      throw new Error(`租户 ${tenantId} 并发查询已达上限 (${this.maxPerTenant})`);
    }
    this.active.set(tenantId, current + 1);
    try {
      return await fn();
    } finally {
      const next = (this.active.get(tenantId) ?? 1) - 1;
      if (next <= 0) this.active.delete(tenantId);
      else this.active.set(tenantId, next);
    }
  }
}
