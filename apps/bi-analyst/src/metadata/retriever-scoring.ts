import type { AccessPolicy } from "../policy/access-policy.js";
import type { SchemaDocument } from "./types.js";
import type { SchemaSearchOptions } from "./retriever.js";

/** 简单关键词相关度评分 */
export function scoreDocument(query: string, doc: SchemaDocument): number {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  let score = 0;
  const haystack = [
    doc.content,
    doc.table,
    doc.column,
    doc.datasourceId,
    ...(doc.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }

  if (doc.docType === "metric" && /gmv|总额|金额|订单/.test(q)) {
    if (/amount|gmv|总额|金额/.test(haystack)) score += 5;
  }
  if (/北京|城市|city/.test(q) && /city|城市/.test(haystack)) score += 4;
  if (/用户|user/.test(q) && /user/.test(haystack)) score += 3;
  if (/订单|order/.test(q) && /order/.test(haystack)) score += 3;

  return score;
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
    if (policy?.deniedTables?.length && doc.table) {
      if (policy.deniedTables.includes(doc.table)) return false;
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

  if (options.docType === "column" && options.tables?.length) {
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
