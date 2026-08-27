import type { HealthStatus, SqlExecutor } from "./types.js";

/**
 * 按 dataSourceId 解析 SqlExecutor（Phase D）。
 * Agent 执行节点必须经此路由，禁止固定绑定单一 SQLite executor。
 */
export class ExecutorRegistry {
  private readonly byId = new Map<string, SqlExecutor>();
  private defaultExecutor: SqlExecutor | null = null;

  register(dataSourceId: string, executor: SqlExecutor): this {
    this.byId.set(dataSourceId, executor);
    return this;
  }

  setDefault(executor: SqlExecutor): this {
    this.defaultExecutor = executor;
    return this;
  }

  has(dataSourceId: string): boolean {
    return this.byId.has(dataSourceId);
  }

  listIds(): string[] {
    return [...this.byId.keys()];
  }

  /**
   * 解析执行器：精确 id → default → 抛错（fail closed，不静默串源）。
   */
  resolve(dataSourceId: string | null | undefined): SqlExecutor {
    if (dataSourceId && this.byId.has(dataSourceId)) {
      return this.byId.get(dataSourceId)!;
    }
    if (this.defaultExecutor) {
      return this.defaultExecutor;
    }
    throw new Error(
      dataSourceId
        ? `数据源 ${dataSourceId} 未注册 SqlExecutor`
        : "缺少 dataSourceId 且未配置默认 SqlExecutor",
    );
  }

  /** 安全解析：未命中时返回 null */
  tryResolve(dataSourceId: string | null | undefined): SqlExecutor | null {
    try {
      return this.resolve(dataSourceId);
    } catch {
      return null;
    }
  }

  async healthCheckAll(timeoutMs = 2_000): Promise<Record<string, HealthStatus>> {
    const entries = [...this.byId.entries()];
    return Object.fromEntries(
      await Promise.all(
        entries.map(async ([id, executor]) => {
          const started = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              executor.healthCheck(),
              new Promise<HealthStatus>((resolve) =>
                (timer = setTimeout(
                  () => resolve({ healthy: false, message: "health check timeout" }),
                  timeoutMs,
                )),
              ),
            ]);
            return [id, { ...result, latencyMs: result.latencyMs ?? Date.now() - started }] as const;
          } catch (error) {
            return [
              id,
              {
                healthy: false,
                message: error instanceof Error ? error.message : String(error),
                latencyMs: Date.now() - started,
              },
            ] as const;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      ),
    );
  }

  async closeAll(): Promise<void> {
    const seen = new Set<SqlExecutor>();
    const executors: SqlExecutor[] = [];
    for (const ex of this.byId.values()) {
      if (seen.has(ex)) continue;
      seen.add(ex);
      executors.push(ex);
    }
    if (this.defaultExecutor && !seen.has(this.defaultExecutor)) {
      executors.push(this.defaultExecutor);
    }
    const results = await Promise.allSettled(executors.map((executor) => executor.close()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close datasource executors");
    }
  }
}

export function createExecutorRegistry(
  entries: Array<{ id: string; executor: SqlExecutor }>,
  defaultExecutor?: SqlExecutor,
): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  for (const e of entries) {
    registry.register(e.id, e.executor);
  }
  if (defaultExecutor) {
    registry.setDefault(defaultExecutor);
  }
  return registry;
}
