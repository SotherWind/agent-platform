import type { AccessPolicy } from "../policy/access-policy.js";
import type { RetrievedSchema } from "./types.js";
import type { SchemaRetriever } from "./retriever.js";
import { retrieveRelevantSchema } from "./retriever.js";
import { assembleSchema } from "./schema-assembler.js";

export interface GoldenQueryExpectation {
  id: string;
  description?: string;
  query: string;
  expected: {
    datasourceId: string;
    tables: string[];
    columns: string[];
    forbiddenColumns?: string[];
  };
}

export interface GoldenQueryEvalResult {
  id: string;
  query: string;
  datasourceId: string;
  tableRecall: number;
  columnRecall: number;
  forbiddenLeaks: string[];
  passed: boolean;
  missingTables: string[];
  missingColumns: string[];
}

function recallRate(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1;
  const actualSet = new Set(actual);
  const hit = expected.filter((item) => actualSet.has(item)).length;
  return hit / expected.length;
}

/** 对单个 golden query 评估 Schema RAG 召回 */
export async function evaluateGoldenQuery(
  retriever: SchemaRetriever,
  golden: GoldenQueryExpectation,
  policy: AccessPolicy,
): Promise<GoldenQueryEvalResult> {
  const retrieved = await retrieveRelevantSchema(
    retriever,
    golden.query,
    policy,
  );

  const assembled: RetrievedSchema = assembleSchema({
    datasourceId: retrieved.datasourceId,
    dialectFamily: retrieved.dialectFamily,
    documents: retrieved.documents,
    policy,
  });

  const tableNames = assembled.tables.map((t) => t.name);
  const columnKeys = assembled.tables.flatMap((t) =>
    t.columns.map((c) => `${t.name}.${c.name}`),
  );

  const missingTables = golden.expected.tables.filter(
    (t) => !tableNames.includes(t),
  );
  const missingColumns = golden.expected.columns.filter(
    (c) => !columnKeys.includes(c),
  );

  const forbidden = golden.expected.forbiddenColumns ?? [];
  const forbiddenLeaks = forbidden.filter((c) => columnKeys.includes(c));

  const tableRecall = recallRate(golden.expected.tables, tableNames);
  const columnRecall = recallRate(golden.expected.columns, columnKeys);

  const passed =
    retrieved.datasourceId === golden.expected.datasourceId &&
    missingTables.length === 0 &&
    missingColumns.length === 0 &&
    forbiddenLeaks.length === 0;

  return {
    id: golden.id,
    query: golden.query,
    datasourceId: retrieved.datasourceId,
    tableRecall,
    columnRecall,
    forbiddenLeaks,
    passed,
    missingTables,
    missingColumns,
  };
}

export async function evaluateGoldenQuerySet(
  retriever: SchemaRetriever,
  goldenQueries: GoldenQueryExpectation[],
  policy: AccessPolicy,
): Promise<{
  results: GoldenQueryEvalResult[];
  passRate: number;
  avgTableRecall: number;
  avgColumnRecall: number;
}> {
  const results: GoldenQueryEvalResult[] = [];
  for (const golden of goldenQueries) {
    results.push(await evaluateGoldenQuery(retriever, golden, policy));
  }

  const passed = results.filter((r) => r.passed).length;
  const passRate = goldenQueries.length === 0 ? 1 : passed / goldenQueries.length;
  const avgTableRecall =
    results.reduce((sum, r) => sum + r.tableRecall, 0) / (results.length || 1);
  const avgColumnRecall =
    results.reduce((sum, r) => sum + r.columnRecall, 0) / (results.length || 1);

  return { results, passRate, avgTableRecall, avgColumnRecall };
}
