import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const MetricDimensionSchema = z.object({
  name: z.string(),
  table: z.string(),
  column: z.string(),
  joinPath: z.string().optional(),
});

const JoinEdgeSchema = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
  fromKey: z.string(),
  toKey: z.string(),
  cardinality: z.enum(["one_to_one", "many_to_one", "one_to_many", "many_to_many"]),
});

const DefaultFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(["=", "!=", "in", "not_in"]),
  value: z.union([
    z.string(),
    z.number(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});

const MetricCertificationSchema = z.object({
  certifiedBy: z.string().optional(),
  certifiedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  ticket: z.string().optional(),
});

export const MetricDefinitionSchema = z.object({
  metric: z.string(),
  version: z.number().int().positive(),
  label: z.string(),
  description: z.string().optional(),
  businessDefinition: z.string().optional(),
  datasourceId: z.string(),
  status: z.enum(["draft", "certified", "deprecated"]),
  owner: z.string(),
  factTable: z.string(),
  entityKey: z.string(),
  measure: z.object({
    field: z.string(),
    aggregation: z.enum(["sum", "count", "avg", "min", "max", "count_distinct"]),
    additive: z.boolean().default(true),
  }),
  timeDimension: z.string(),
  timezone: z.string().default("Asia/Shanghai"),
  unit: z.string(),
  defaultFilters: z.array(DefaultFilterSchema).default([]),
  dimensions: z.array(MetricDimensionSchema).default([]),
  synonyms: z.array(z.string()).default([]),
  joinGraph: z.array(JoinEdgeSchema).default([]),
  freshnessSlaHours: z.number().positive().optional(),
  requireTimeRange: z.boolean().default(false),
  /** Optional formula for a governed derived metric. */
  formula: z.string().trim().min(1).optional(),
  /** Metric identifiers referenced by formula, kept explicit for review tooling. */
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  certification: MetricCertificationSchema.optional(),
});

export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export interface MetricGovernanceIssue {
  metric: string;
  version: number;
  severity: "error" | "warning";
  code:
    | "duplicate_version"
    | "unknown_dependency"
    | "dependency_cycle"
    | "invalid_formula"
    | "invalid_validity_window"
    | "deprecated_latest"
    | "missing_certification_metadata";
  message: string;
}

export class MetricRegistry {
  private readonly byId = new Map<string, MetricDefinition>();
  private readonly bySynonym = new Map<string, string[]>();
  private readonly versions = new Map<string, MetricDefinition[]>();
  private readonly registrationIssues: MetricGovernanceIssue[] = [];

  static fromDirectory(dir: string): MetricRegistry {
    const registry = new MetricRegistry();
    if (!fs.existsSync(dir)) return registry;
    walkYamlFiles(dir, (filePath) => {
      const raw = fs.readFileSync(filePath, "utf8");
      const doc = parseYaml(raw);
      const metric = MetricDefinitionSchema.parse(doc);
      registry.register(metric);
    });
    return registry;
  }

  static fromDefinitions(defs: MetricDefinition[]): MetricRegistry {
    const registry = new MetricRegistry();
    for (const def of defs) registry.register(def);
    return registry;
  }

  register(metric: MetricDefinition): void {
    const existingVersions = this.versions.get(metric.metric) ?? [];
    const sameVersion = existingVersions.find((entry) => entry.version === metric.version);
    if (sameVersion) {
      this.registrationIssues.push({
        metric: metric.metric,
        version: metric.version,
        severity: "error",
        code: "duplicate_version",
        message: `Metric ${metric.metric} version ${metric.version} is registered more than once`,
      });
      return;
    }
    existingVersions.push(metric);
    existingVersions.sort((a, b) => b.version - a.version);
    this.versions.set(metric.metric, existingVersions);

    const current = this.byId.get(metric.metric);
    if (!current || metric.version > current.version) {
      this.byId.set(metric.metric, metric);
    }
    const keys = [metric.metric, metric.label, ...metric.synonyms];
    for (const key of keys) {
      const normalized = normalizeKey(key);
      const existing = this.bySynonym.get(normalized) ?? [];
      if (!existing.includes(metric.metric)) {
        existing.push(metric.metric);
        this.bySynonym.set(normalized, existing);
      }
    }
  }

  get(id: string): MetricDefinition | undefined {
    return this.byId.get(id);
  }

  getVersion(id: string, version: number): MetricDefinition | undefined {
    return this.versions.get(id)?.find((metric) => metric.version === version);
  }

  listVersions(id: string): MetricDefinition[] {
    return [...(this.versions.get(id) ?? [])];
  }

  listAll(): MetricDefinition[] {
    return [...this.versions.values()].flat();
  }

  /** Validate dependency graphs and lifecycle metadata before publishing metrics. */
  validateGovernance(): MetricGovernanceIssue[] {
    const issues = [...this.registrationIssues];
    const all = this.listAll();
    const known = new Set(all.map((metric) => metric.metric));

    for (const metric of all) {
      if (metric.validFrom && metric.validTo && Date.parse(metric.validFrom) > Date.parse(metric.validTo)) {
        issues.push({
          metric: metric.metric,
          version: metric.version,
          severity: "error",
          code: "invalid_validity_window",
          message: `Metric ${metric.metric} has validFrom after validTo`,
        });
      }
      if (metric.status === "certified" && !metric.certification?.certifiedBy) {
        issues.push({
          metric: metric.metric,
          version: metric.version,
          severity: "warning",
          code: "missing_certification_metadata",
          message: `Certified metric ${metric.metric} has no certification.certifiedBy`,
        });
      }
      if (metric.formula) {
        if (!/^[a-zA-Z0-9_+*/().\s-]+$/.test(metric.formula)) {
          issues.push({
            metric: metric.metric,
            version: metric.version,
            severity: "error",
            code: "invalid_formula",
            message: `Metric ${metric.metric} formula contains unsupported characters`,
          });
        }
        const referenced = [...metric.formula.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)]
          .map((match) => match[0]!)
          .filter((token) => !["sum", "avg", "min", "max", "count"].includes(token.toLowerCase()));
        for (const dependency of [...new Set([...metric.dependsOn, ...referenced])]) {
          if (!known.has(dependency)) {
            issues.push({
              metric: metric.metric,
              version: metric.version,
              severity: "error",
              code: "unknown_dependency",
              message: `Metric ${metric.metric} depends on unknown metric ${dependency}`,
            });
          }
        }
      }
      for (const dependency of metric.dependsOn) {
        if (dependency === metric.metric) {
          issues.push({
            metric: metric.metric,
            version: metric.version,
            severity: "error",
            code: "dependency_cycle",
            message: `Metric ${metric.metric} cannot depend on itself`,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, pathStack: string[]) => {
      if (visiting.has(id)) {
        const metric = this.get(id);
        issues.push({
          metric: id,
          version: metric?.version ?? 1,
          severity: "error",
          code: "dependency_cycle",
          message: `Metric dependency cycle detected: ${[...pathStack, id].join(" -> ")}`,
        });
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const metric = this.get(id);
      for (const dependency of metric?.dependsOn ?? []) {
        if (known.has(dependency)) visit(dependency, [...pathStack, id]);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of known) visit(id, []);

    for (const [id, versions] of this.versions) {
      const latest = versions[0];
      if (latest?.status === "deprecated") {
        issues.push({
          metric: id,
          version: latest.version,
          severity: "warning",
          code: "deprecated_latest",
          message: `Latest metric version ${id}@${latest.version} is deprecated`,
        });
      }
    }
    return issues;
  }

  /** 从自然语言粗匹配指标；多命中需澄清 */
  matchByQuery(query: string): MetricDefinition[] {
    const q = normalizeKey(query);
    const hits = new Map<string, MetricDefinition>();

    for (const [syn, ids] of this.bySynonym) {
      if (q.includes(syn) || syn.includes(q)) {
        for (const id of ids) {
          const m = this.byId.get(id);
          if (m?.status === "certified") hits.set(id, m);
        }
      }
    }

    // 额外关键词启发式
    for (const m of this.listCertified()) {
      for (const syn of [m.metric, m.label, ...m.synonyms]) {
        const s = normalizeKey(syn);
        if (s.length >= 2 && q.includes(s)) hits.set(m.metric, m);
      }
    }

    return [...hits.values()];
  }

  listCertified(): MetricDefinition[] {
    return [...this.byId.values()].filter((m) => m.status === "certified");
  }

  /** 缓存 key 用：certified 指标版本指纹 */
  versionFingerprint(): string {
    const parts = [...this.byId.values()]
      .filter((m) => m.status === "certified")
      .sort((a, b) => a.metric.localeCompare(b.metric))
      .map((m) => `${m.metric}:${m.version}:${m.formula ?? ""}`);
    if (parts.length === 0) return "none";
    return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  }
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function walkYamlFiles(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkYamlFiles(full, visit);
    else if (/\.ya?ml$/i.test(entry.name)) visit(full);
  }
}

export function defaultMetricsDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../metadata/metrics",
  );
}
