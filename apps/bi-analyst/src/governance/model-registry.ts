export interface ModelVersion {
  id: string;
  provider: string;
  model: string;
  promptVersion: string;
  /** 单请求 token 预算（提示；实际消耗由调用方计量） */
  costBudgetTokensPerRequest: number;
  certified: boolean;
}

export interface ModelCanaryConfig {
  canaryVersionId: string;
  /** 0～100：命中 canary 的流量百分比 */
  trafficPercent: number;
}

export interface ModelRolloutSnapshot {
  activeId: string | null;
  previousActiveId: string | null;
  canary: ModelCanaryConfig | null;
}

/** Prompt/模型版本登记 + 成本预算 + 灰度 canary + 回滚 */
export class ModelVersionRegistry {
  protected readonly versions = new Map<string, ModelVersion>();
  protected activeId: string | null = null;
  protected previousActiveId: string | null = null;
  protected canary: ModelCanaryConfig | null = null;

  register(version: ModelVersion): void {
    this.versions.set(version.id, version);
    if (!this.activeId) this.activeId = version.id;
  }

  setActive(id: string): void {
    if (!this.versions.has(id)) {
      throw new Error(`未知模型版本: ${id}`);
    }
    if (this.activeId && this.activeId !== id) {
      this.previousActiveId = this.activeId;
    }
    this.activeId = id;
  }

  setCanary(config: ModelCanaryConfig | null): void {
    if (config && !this.versions.has(config.canaryVersionId)) {
      throw new Error(`未知 canary 模型版本: ${config.canaryVersionId}`);
    }
    if (config) {
      const pct = Math.min(100, Math.max(0, config.trafficPercent));
      this.canary = { ...config, trafficPercent: pct };
    } else {
      this.canary = null;
    }
  }

  getCanary(): ModelCanaryConfig | null {
    return this.canary ? { ...this.canary } : null;
  }

  getActive(): ModelVersion | undefined {
    return this.activeId ? this.versions.get(this.activeId) : undefined;
  }

  getPreviousActive(): ModelVersion | undefined {
    return this.previousActiveId
      ? this.versions.get(this.previousActiveId)
      : undefined;
  }

  snapshot(): ModelRolloutSnapshot {
    return {
      activeId: this.activeId,
      previousActiveId: this.previousActiveId,
      canary: this.getCanary(),
    };
  }

  /** 将 canary 提升为 active，并清除灰度 */
  promoteCanary(): ModelVersion {
    if (!this.canary) {
      throw new Error("当前无 canary 可提升");
    }
    const id = this.canary.canaryVersionId;
    this.setActive(id);
    this.canary = null;
    const active = this.getActive();
    if (!active) throw new Error("提升失败");
    return active;
  }

  /** 回滚到 previousActive；若有 canary 一并清除 */
  rollback(): ModelVersion {
    if (!this.previousActiveId) {
      throw new Error("无可回滚的上一版本");
    }
    const target = this.previousActiveId;
    const current = this.activeId;
    this.activeId = target;
    this.previousActiveId = current;
    this.canary = null;
    const restored = this.getActive();
    if (!restored) throw new Error("回滚失败");
    return restored;
  }

  /** 按主体稳定哈希分流 canary / stable */
  resolveForSubject(subjectId: string): ModelVersion | undefined {
    const stable = this.getActive();
    if (!this.canary || !stable) return stable;
    if (this.canary.canaryVersionId === stable.id) return stable;
    const bucket = stableHashBucket(subjectId);
    if (bucket < this.canary.trafficPercent) {
      return this.versions.get(this.canary.canaryVersionId) ?? stable;
    }
    return stable;
  }

  list(): ModelVersion[] {
    return [...this.versions.values()];
  }

  withinBudget(estimatedTokens: number, version?: ModelVersion): boolean {
    const target = version ?? this.getActive();
    if (!target) return true;
    return estimatedTokens <= target.costBudgetTokensPerRequest;
  }

  async initializeAsync(): Promise<void> {}

  async refreshAsync(): Promise<void> {}

  async registerAsync(version: ModelVersion): Promise<void> {
    this.register(version);
  }

  async setCanaryAsync(config: ModelCanaryConfig | null): Promise<void> {
    this.setCanary(config);
  }

  async promoteCanaryAsync(): Promise<ModelVersion> {
    return this.promoteCanary();
  }

  async rollbackAsync(): Promise<ModelVersion> {
    return this.rollback();
  }

  protected restoreState(state: {
    versions: ModelVersion[];
    activeId: string | null;
    previousActiveId: string | null;
    canary: ModelCanaryConfig | null;
  }): void {
    this.versions.clear();
    for (const version of state.versions) {
      this.versions.set(version.id, version);
    }
    this.activeId = state.activeId;
    this.previousActiveId = state.previousActiveId;
    this.canary = state.canary ? { ...state.canary } : null;
  }
}

/** File-backed registry used when a deployed profile has no ORM dependency. */
export class PersistentModelVersionRegistry extends ModelVersionRegistry {
  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  override register(version: ModelVersion): void {
    super.register(version);
    this.save();
  }

  override setActive(id: string): void {
    super.setActive(id);
    this.save();
  }

  override setCanary(config: ModelCanaryConfig | null): void {
    super.setCanary(config);
    this.save();
  }

  override promoteCanary(): ModelVersion {
    const active = super.promoteCanary();
    this.save();
    return active;
  }

  override rollback(): ModelVersion {
    const active = super.rollback();
    this.save();
    return active;
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(this.filePath), "utf8")) as {
        versions?: ModelVersion[];
        activeId?: string | null;
        previousActiveId?: string | null;
        canary?: ModelCanaryConfig | null;
      };
      for (const version of raw.versions ?? []) super.register(version);
      if (raw.previousActiveId && raw.previousActiveId !== raw.activeId) {
        super.setActive(raw.previousActiveId);
      }
      if (raw.activeId) super.setActive(raw.activeId);
      if (raw.canary) super.setCanary(raw.canary);
    } catch {
      // A missing state file starts an empty registry and is populated by bootstrap.
    }
  }

  private save(): void {
    const absolute = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const payload = {
      versions: this.list(),
      activeId: this.snapshot().activeId,
      previousActiveId: this.snapshot().previousActiveId,
      canary: this.getCanary(),
    };
    const temp = `${absolute}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, absolute);
  }
}

function stableHashBucket(subjectId: string): number {
  let h = 0;
  for (let i = 0; i < subjectId.length; i += 1) {
    h = (h * 31 + subjectId.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

export function createDefaultModelRegistry(): ModelVersionRegistry {
  const registry = new ModelVersionRegistry();
  registry.register({
    id: "default-sql-v1",
    provider: "openai-compatible",
    model: "gpt-4.1-mini",
    promptVersion: "bi-sql-prompt@1",
    costBudgetTokensPerRequest: 8_000,
    certified: false,
  });
  registry.register({
    id: "default-sql-v2-canary",
    provider: "openai-compatible",
    model: "gpt-4.1",
    promptVersion: "bi-sql-prompt@2",
    costBudgetTokensPerRequest: 12_000,
    certified: false,
  });
  return registry;
}
import fs from "node:fs";
import path from "node:path";
