/**
 * Text-to-SQL 准确率评测：规范化 SQL + 对照 golden 打分。
 * 离线可注入 mock 生成器；live 模式调用真实 LLM。
 */

export interface TextToSqlGoldenCase {
  id: string;
  description: string;
  query: string;
  dialect?: string;
  schema?: unknown;
  /** 生成 SQL 必须包含的子串（大小写不敏感） */
  mustContain: string[];
  /** 禁止出现的子串（写入类等） */
  mustNotContain?: string[];
  /** 表名必须出现（规范化后） */
  requiredTables?: string[];
}

export interface TextToSqlCaseResult {
  id: string;
  passed: boolean;
  sql: string;
  missingContains: string[];
  forbiddenHits: string[];
  missingTables: string[];
  error?: string;
}

export interface TextToSqlEvalReport {
  cases: number;
  passed: number;
  passRate: number;
  results: TextToSqlCaseResult[];
}

export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function scoreGeneratedSql(
  sql: string,
  golden: TextToSqlGoldenCase,
): TextToSqlCaseResult {
  const normalized = normalizeSql(sql);
  const missingContains = (golden.mustContain ?? []).filter(
    (token) => !normalized.includes(token.toLowerCase()),
  );
  const forbiddenHits = (golden.mustNotContain ?? []).filter((token) =>
    normalized.includes(token.toLowerCase()),
  );
  const missingTables = (golden.requiredTables ?? []).filter(
    (table) => !normalized.includes(table.toLowerCase()),
  );

  return {
    id: golden.id,
    passed:
      missingContains.length === 0 &&
      forbiddenHits.length === 0 &&
      missingTables.length === 0 &&
      normalized.length > 0,
    sql,
    missingContains,
    forbiddenHits,
    missingTables,
  };
}

export type SqlGenerator = (input: {
  query: string;
  schema?: unknown;
  dialect?: string;
}) => Promise<string>;

export async function evaluateTextToSqlCases(
  cases: TextToSqlGoldenCase[],
  generateSql: SqlGenerator,
): Promise<TextToSqlEvalReport> {
  const results: TextToSqlCaseResult[] = [];

  for (const golden of cases) {
    try {
      const sql = await generateSql({
        query: golden.query,
        schema: golden.schema,
        dialect: golden.dialect ?? "sqlite",
      });
      results.push(scoreGeneratedSql(sql, golden));
    } catch (err) {
      results.push({
        id: golden.id,
        passed: false,
        sql: "",
        missingContains: golden.mustContain,
        forbiddenHits: [],
        missingTables: golden.requiredTables ?? [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    cases: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
}
