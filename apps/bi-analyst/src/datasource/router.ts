import type { AccessPolicy } from "../policy/access-policy.js";
import type { ClarificationRequest } from "../query-plan/clarification.js";
import type { SchemaRetriever } from "../metadata/retriever.js";
import type { DataSourceConfig } from "./types.js";
import type { DataSourceRegistry } from "./registry.js";
import type { AuthenticatedPrincipal } from "../auth/types.js";

export interface DatasourceRouteInput {
  query: string;
  principal: AuthenticatedPrincipal;
  policy: AccessPolicy;
  registry: DataSourceRegistry;
  /** Workspace/tenant default; users should not repeat the database in a query. */
  preferredDataSourceId?: string | null;
  /** 会话延续优先源 */
  sessionLastDataSourceId?: string | null;
  /** 是否检测为追问（延续上源） */
  isFollowUp?: boolean;
  confidenceThreshold?: number;
  /**
   * 可选 SchemaRetriever：多源时对 docType=datasource 检索并与启发式分融合。
   * 同步 `routeDataSource` 忽略此字段；请用 `routeDataSourceAsync`。
   */
  schemaRetriever?: SchemaRetriever;
  /** 启发式权重 0～1，默认 0.4；向量权重 = 1 - heuristicWeight */
  heuristicWeight?: number;
}

export interface DatasourceRouteResult {
  ok: boolean;
  dataSourceId?: string;
  dialectFamily?: DataSourceConfig["dialectFamily"];
  confidence: number;
  candidates: Array<{ id: string; score: number; label: string }>;
  clarification?: ClarificationRequest;
  reason?: string;
  /** 打分来源：heuristic | fused */
  scoring?: "heuristic" | "fused";
}

const CROSS_SOURCE_PATTERNS =
  /跨库|跨源|联合查询|联邦|把 .+ 和 .+ 关联|join across|cross[\s-]?source/i;

/**
 * 单查询选单源（同步启发式）。
 * 需要向量融合时请用 `routeDataSourceAsync`。
 */
export function routeDataSource(
  input: DatasourceRouteInput,
): DatasourceRouteResult {
  const early = earlyRoute(input);
  if (early) return early;

  const authorized = input.registry.getAuthorized(
    input.principal,
    input.policy,
  );
  const scores = new Map(
    authorized.map((s) => [s.id, scoreDataSource(input.query, s)]),
  );
  return finalizeRoute(input, authorized, scores, "heuristic");
}

/**
 * 单查询选单源：权限过滤 → 会话 → 唯一源 → 启发式×向量融合 → 低置信度澄清。
 */
export async function routeDataSourceAsync(
  input: DatasourceRouteInput,
): Promise<DatasourceRouteResult> {
  const early = earlyRoute(input);
  if (early) return early;

  const authorized = input.registry.getAuthorized(
    input.principal,
    input.policy,
  );
  const heuristic = new Map(
    authorized.map((s) => [s.id, scoreDataSource(input.query, s)]),
  );

  if (!input.schemaRetriever || authorized.length <= 1) {
    return finalizeRoute(input, authorized, heuristic, "heuristic");
  }

  const vectorScores = await fetchVectorDatasourceScores(
    input.schemaRetriever,
    input.query,
    input.policy,
    authorized,
  );
  const hw = clamp01(input.heuristicWeight ?? 0.4);
  const fused = new Map<string, number>();
  for (const source of authorized) {
    const h = heuristic.get(source.id) ?? 0;
    const v = vectorScores.get(source.id) ?? 0;
    fused.set(source.id, hw * h + (1 - hw) * v);
  }

  return finalizeRoute(input, authorized, fused, "fused");
}

function earlyRoute(
  input: DatasourceRouteInput,
): DatasourceRouteResult | null {
  const authorized = input.registry.getAuthorized(
    input.principal,
    input.policy,
  );

  if (authorized.length === 0) {
    return {
      ok: false,
      confidence: 0,
      candidates: [],
      reason: "当前主体无可用数据源",
      clarification: {
        reason: "unauthorized_scope",
        question: "当前身份没有可访问的数据源",
      },
    };
  }

  if (CROSS_SOURCE_PATTERNS.test(input.query)) {
    return {
      ok: false,
      confidence: 0,
      candidates: authorized.map((s) => ({
        id: s.id,
        score: 0,
        label: s.label,
      })),
      clarification: {
        reason: "cross_source_query",
        question:
          "当前不支持跨数据源联合查询。请选择单一数据源，或拆分为多次分析。",
        options: authorized.map((s) => ({
          id: `datasource.${s.id}`,
          label: s.label,
        })),
      },
    };
  }

  const explicitSources = authorized.filter((source) =>
    hasExplicitProductMention(input.query, source),
  );
  if (explicitSources.length === 1) {
    const source = explicitSources[0]!;
    return {
      ok: true,
      dataSourceId: source.id,
      dialectFamily: source.dialectFamily,
      confidence: 0.99,
      candidates: [{ id: source.id, score: 0.99, label: source.label }],
      scoring: "heuristic",
    };
  }

  if (
    input.isFollowUp &&
    input.sessionLastDataSourceId &&
    authorized.some((s) => s.id === input.sessionLastDataSourceId)
  ) {
    const source = authorized.find(
      (s) => s.id === input.sessionLastDataSourceId,
    )!;
    return {
      ok: true,
      dataSourceId: source.id,
      dialectFamily: source.dialectFamily,
      confidence: 0.95,
      candidates: [{ id: source.id, score: 0.95, label: source.label }],
      scoring: "heuristic",
    };
  }

  if (input.preferredDataSourceId) {
    const source = authorized.find(
      (s) => s.id === input.preferredDataSourceId,
    );
    if (source) {
      return {
        ok: true,
        dataSourceId: source.id,
        dialectFamily: source.dialectFamily,
        confidence: 0.9,
        candidates: [{ id: source.id, score: 0.9, label: source.label }],
        scoring: "heuristic",
      };
    }
  }

  if (authorized.length === 1) {
    const source = authorized[0]!;
    return {
      ok: true,
      dataSourceId: source.id,
      dialectFamily: source.dialectFamily,
      confidence: 1,
      candidates: [{ id: source.id, score: 1, label: source.label }],
      scoring: "heuristic",
    };
  }

  return null;
}

function finalizeRoute(
  input: DatasourceRouteInput,
  authorized: DataSourceConfig[],
  scoreById: Map<string, number>,
  scoring: "heuristic" | "fused",
): DatasourceRouteResult {
  const threshold = input.confidenceThreshold ?? 0.55;
  const scored = authorized
    .map((source) => ({
      source,
      score: scoreById.get(source.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  const second = scored[1];
  const candidates = scored.map((s) => ({
    id: s.source.id,
    score: roundScore(s.score),
    label: s.source.label,
  }));

  if (
    second &&
    top.score > 0 &&
    Math.abs(top.score - second.score) < 0.08 &&
    second.score >= threshold
  ) {
    const collapsed = collapseEquivalentSources(scored);
    if (collapsed) {
      return {
        ok: true,
        dataSourceId: collapsed.id,
        dialectFamily: collapsed.dialectFamily,
        confidence: Math.max(top.score, 0.7),
        candidates,
        scoring,
      };
    }
    return {
      ok: false,
      confidence: roundScore(top.score),
      candidates,
      scoring,
      clarification: {
        reason: "ambiguous_datasource",
        question: "匹配到多个数据源，请选择要分析的数据源",
        options: scored.slice(0, 3).map((s) => ({
          id: `datasource.${s.source.id}`,
          label: s.source.label,
        })),
      },
    };
  }

  if (top.score < threshold) {
    const preferred =
      isLocalAliasSet(authorized) ||
      (authorized.every(isCollapsibleConnection) &&
        new Set(authorized.map(connectionKey)).size === 1)
        ? pickPreferredLocalSource(authorized)
        : undefined;
    if (preferred) {
      return {
        ok: true,
        dataSourceId: preferred.id,
        dialectFamily: preferred.dialectFamily,
        confidence: Math.max(top.score, 0.6),
        candidates,
        scoring,
      };
    }
    return {
      ok: false,
      confidence: roundScore(top.score),
      candidates,
      scoring,
      clarification: {
        reason: "ambiguous_datasource",
        question: "无法确定应使用哪个数据源，请选择",
        options: authorized.map((s) => ({
          id: `datasource.${s.id}`,
          label: s.label,
        })),
      },
    };
  }

  return {
    ok: true,
    dataSourceId: top.source.id,
    dialectFamily: top.source.dialectFamily,
    confidence: roundScore(top.score),
    candidates,
    scoring,
  };
}

async function fetchVectorDatasourceScores(
  retriever: SchemaRetriever,
  query: string,
  policy: AccessPolicy,
  authorized: DataSourceConfig[],
): Promise<Map<string, number>> {
  const allowed = new Set(authorized.map((s) => s.id));
  try {
    const docs = await retriever.search(
      query,
      { docType: "datasource", limit: Math.max(authorized.length, 5) },
      policy,
    );
    const raw = new Map<string, number>();
    let rank = docs.length;
    for (const doc of docs) {
      if (!allowed.has(doc.datasourceId)) continue;
      // 排序靠前得分更高；同 id 取最大
      const score = rank / docs.length;
      const prev = raw.get(doc.datasourceId) ?? 0;
      raw.set(doc.datasourceId, Math.max(prev, score));
      rank -= 1;
    }
    // 未命中的源给极低分，避免 NaN
    for (const s of authorized) {
      if (!raw.has(s.id)) raw.set(s.id, 0);
    }
    return raw;
  } catch {
    return new Map(authorized.map((s) => [s.id, 0]));
  }
}

export function scoreDataSource(
  query: string,
  source: DataSourceConfig,
): number {
  const q = query.toLowerCase();
  let score = 0.1;

  if (source.domain && q.includes(source.domain.toLowerCase())) score += 0.35;
  if (q.includes(source.id.toLowerCase())) score += 0.4;
  if (q.includes(source.label.toLowerCase())) score += 0.35;

  if (source.domain === "retail" && /订单|销售|gmv|用户|商品|零售/.test(q)) {
    score += 0.3;
  }
  if (source.domain === "finance" && /财务|收入|营收|会计|总账/.test(q)) {
    score += 0.3;
  }
  if (source.domain === "healthcare" && /患者|就诊|医院|病历/.test(q)) {
    score += 0.3;
  }

  if (source.dialectFamily === "sqlite" && /演示|demo|sqlite/.test(q)) {
    score += 0.2;
  }
  const productType = source.productType.toLowerCase();
  if (productType === "mysql" && /mysql/.test(q)) score += 0.65;
  if (productType === "mariadb" && /mariadb/.test(q)) score += 0.65;
  if (productType === "postgresql" && /postgres|pg\b/.test(q)) score += 0.65;
  if (productType === "oracle" && /oracle/.test(q)) score += 0.65;
  if (productType === "sqlserver" && /sql\s*server|tsql|t-sql/.test(q)) {
    score += 0.65;
  }

  return Math.min(1, score);
}

function hasExplicitProductMention(
  query: string,
  source: DataSourceConfig,
): boolean {
  const q = query.toLowerCase();
  switch (source.productType.toLowerCase()) {
    case "sqlite":
      return /\bsqlite\b/.test(q);
    case "mysql":
      return /\bmysql\b/.test(q);
    case "mariadb":
      return /\bmariadb\b/.test(q);
    case "postgresql":
      return /\bpostgres(?:ql)?\b|\bpg\b/.test(q);
    case "oracle":
      return /\boracle\b/.test(q);
    case "sqlserver":
      return /\bsql\s*server\b|\btsql\b|\bt-sql\b/.test(q);
    default:
      return false;
  }
}

const PREFERRED_LOCAL_IDS = ["ecommerce_sqlite", "test", "default"];

function connectionKey(source: DataSourceConfig): string {
  return [
    source.dialectFamily,
    source.domain,
    source.connection.filePath ?? "",
    source.connection.host ?? "",
    source.connection.database ?? "",
  ].join("|");
}

function isLocalAliasSet(sources: DataSourceConfig[]): boolean {
  return sources.every((s) => PREFERRED_LOCAL_IDS.includes(s.id));
}

function isCollapsibleConnection(source: DataSourceConfig): boolean {
  const filePath = source.connection.filePath;
  if (filePath && filePath !== ":memory:") return true;
  if (source.connection.host && source.connection.database) return true;
  return false;
}

function collapseEquivalentSources(
  scored: Array<{ source: DataSourceConfig; score: number }>,
): DataSourceConfig | undefined {
  if (scored.length < 2) return scored[0]?.source;
  const sources = scored.map((s) => s.source);
  if (isLocalAliasSet(sources)) {
    return pickPreferredLocalSource(sources);
  }
  if (!sources.every(isCollapsibleConnection)) return undefined;
  const key = connectionKey(sources[0]!);
  const allSame = sources.every((s) => connectionKey(s) === key);
  if (!allSame) return undefined;
  return pickPreferredLocalSource(sources);
}

function pickPreferredLocalSource(
  sources: DataSourceConfig[],
): DataSourceConfig | undefined {
  if (sources.length === 0) return undefined;
  if (sources.length === 1) return sources[0];

  for (const id of PREFERRED_LOCAL_IDS) {
    const hit = sources.find((s) => s.id === id);
    if (hit) return hit;
  }
  return sources[0];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.4;
  return Math.min(1, Math.max(0, n));
}

function roundScore(n: number): number {
  return Math.round(n * 1000) / 1000;
}
