import type { AccessPolicy } from "../policy/access-policy.js";
import type { SchemaDocument } from "./types.js";
import type { SchemaSearchOptions } from "./retriever.js";

/** 简单关键词相关度评分（支持中文无空格查询） */
export function scoreDocument(query: string, doc: SchemaDocument): number {
  const q = query.toLowerCase();
  const terms = tokenizeQuery(q);
  let score = 0;
  const haystack = [
    doc.content,
    doc.table,
    doc.column,
    doc.datasourceId,
    doc.domain,
    ...(doc.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const term of terms) {
    if (term.length >= 2 && haystack.includes(term)) score += 2;
  }

  if (doc.docType === "metric" && /gmv|总额|金额|订单/.test(q)) {
    if (/amount|gmv|总额|金额/.test(haystack)) score += 5;
  }
  if (/北京|城市|city/.test(q) && /city|城市/.test(haystack)) score += 4;
  if (/用户|user/.test(q) && /user/.test(haystack)) score += 3;
  if (/订单|order/.test(q) && /order/.test(haystack)) score += 3;
  if (
    /财务|收入|营收|会计|总账|finance/.test(q) &&
    /财务|收入|营收|会计|总账|finance/.test(haystack)
  ) {
    score += 5;
  }
  if (
    /零售|销售|商品|gmv|retail/.test(q) &&
    /零售|销售|商品|订单|retail|order/.test(haystack)
  ) {
    score += 4;
  }
  if (doc.domain && q.includes(doc.domain.toLowerCase())) score += 3;

  return score;
}

/** 空格分词 + 常见中文业务词抽取 */
function tokenizeQuery(q: string): string[] {
  const parts = q.split(/[\s,，。；;]+/).filter(Boolean);
  const lexicon = [
    "财务",
    "收入",
    "营收",
    "会计",
    "总账",
    "订单",
    "销售",
    "用户",
    "商品",
    "零售",
    "患者",
    "医院",
    "gmv",
    "mysql",
    "postgres",
    "sqlite",
  ];
  const extras = lexicon.filter((w) => q.includes(w));
  return [...new Set([...parts, ...extras])];
}

export function filterByPolicy(
  docs: SchemaDocument[],
  policy?: AccessPolicy | null,
): SchemaDocument[] {
  return docs.filter((doc) => {
    if (doc.deleted) return false;
    if (doc.reviewStatus && doc.reviewStatus !== "approved") return false;
    if (
      policy?.allowedDataSourceIds?.length &&
      !policy.allowedDataSourceIds.includes(doc.datasourceId)
    ) {
      return false;
    }
    if (policy?.allowedSchemas?.length && doc.schema) {
      if (!policy.allowedSchemas.includes(doc.schema)) return false;
    }
    if (policy?.deniedTables?.length && doc.table) {
      if (policy.deniedTables.includes(doc.table)) return false;
    }
    if (policy?.allowedTables?.length && doc.table) {
      if (!policy.allowedTables.includes(doc.table)) return false;
    }
    if (
      policy?.allowedColumns &&
      doc.table &&
      doc.column &&
      (doc.docType === "column" || doc.docType === "column_group")
    ) {
      const allowed = policy.allowedColumns[doc.table];
      if (allowed && !allowed.includes(doc.column)) return false;
    }
    if (policy?.deniedColumns && doc.table && doc.column) {
      const denied = policy.deniedColumns[doc.table];
      if (denied?.includes(doc.column)) return false;
    }
    return true;
  });
}

/** 对候选文档按关键词评分排序，并补齐 join/time/policy 字段 */
export function rankAndEnrichResults(
  query: string,
  candidates: SchemaDocument[],
  options: SchemaSearchOptions,
  allInScope: SchemaDocument[],
): SchemaDocument[] {
  const scored = candidates
    .map((doc) => ({ doc, score: scoreDocument(query, doc) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const limit = options.limit ?? 10;
  let results = scored.slice(0, limit).map((s) => s.doc);

  if (
    (options.docType === "column" || options.docType === "column_group") &&
    options.tables?.length
  ) {
    const tableSet = new Set(options.tables);
    const mandatory = allInScope.filter(
      (d) =>
        d.table &&
        tableSet.has(d.table) &&
        ["join_key", "time_key", "policy_key", "metric"].includes(
          d.fieldRole ?? "",
        ),
    );
    const seen = new Set(results.map((d) => d.id));
    for (const doc of mandatory) {
      if (!seen.has(doc.id)) {
        results.push(doc);
        seen.add(doc.id);
      }
    }
  }

  return results;
}
