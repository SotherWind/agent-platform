import type { RedisCacheBackend } from "../cache/redis-query-cache.js";
import {
  readRedisJson,
  withRedisLock,
  writeRedisJson,
} from "../state/redis-state.js";
import {
  ModelVersionRegistry,
  type ModelCanaryConfig,
  type ModelVersion,
} from "./model-registry.js";

interface StoredModelRegistry {
  versions: ModelVersion[];
  activeId: string | null;
  previousActiveId: string | null;
  canary: ModelCanaryConfig | null;
}

export class RedisModelVersionRegistry extends ModelVersionRegistry {
  constructor(
    private readonly backend: RedisCacheBackend,
    defaults: ModelVersion[],
    private readonly key = "bi:state:v1:model-registry",
  ) {
    super();
    for (const version of defaults) super.register(version);
  }

  override register(): void {
    throw new Error("RedisModelVersionRegistry requires registerAsync()");
  }

  override setCanary(): void {
    throw new Error("RedisModelVersionRegistry requires setCanaryAsync()");
  }

  override promoteCanary(): ModelVersion {
    throw new Error("RedisModelVersionRegistry requires promoteCanaryAsync()");
  }

  override rollback(): ModelVersion {
    throw new Error("RedisModelVersionRegistry requires rollbackAsync()");
  }

  override async initializeAsync(): Promise<void> {
    await this.backend.ping?.();
    await withRedisLock(this.backend, `${this.key}:lock`, async () => {
      const stored = await readRedisJson<StoredModelRegistry>(
        this.backend,
        this.key,
      );
      if (stored) {
        this.restoreState(stored);
      } else {
        await this.persist();
      }
    });
  }

  override async refreshAsync(): Promise<void> {
    const stored = await readRedisJson<StoredModelRegistry>(
      this.backend,
      this.key,
    );
    if (stored) this.restoreState(stored);
  }

  override async registerAsync(version: ModelVersion): Promise<void> {
    await this.mutate(async () => {
      super.register(version);
    });
  }

  override async setCanaryAsync(
    config: ModelCanaryConfig | null,
  ): Promise<void> {
    await this.mutate(async () => {
      super.setCanary(config);
    });
  }

  override async promoteCanaryAsync(): Promise<ModelVersion> {
    return this.mutate(async () => super.promoteCanary());
  }

  override async rollbackAsync(): Promise<ModelVersion> {
    return this.mutate(async () => super.rollback());
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.backend.ping?.();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return withRedisLock(this.backend, `${this.key}:lock`, async () => {
      await this.refreshAsync();
      const result = await operation();
      await this.persist();
      return result;
    });
  }

  private async persist(): Promise<void> {
    const rollout = this.snapshot();
    await writeRedisJson(this.backend, this.key, {
      versions: this.list(),
      activeId: rollout.activeId,
      previousActiveId: rollout.previousActiveId,
      canary: rollout.canary,
    } satisfies StoredModelRegistry);
  }
}
