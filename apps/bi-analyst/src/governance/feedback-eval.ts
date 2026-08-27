import type { AnalysisFeedback } from "./feedback.js";

export type FeedbackSqlGenerator = (input: {
  query: string;
  schema?: unknown;
  dialect?: string;
}) => Promise<string>;

export interface FeedbackReplayCase {
  id: string;
  sourceFeedbackId: string;
  query: string;
  expectedSql: string;
  dialect: string;
}

export interface FeedbackReplayResult {
  id: string;
  sourceFeedbackId: string;
  passed: boolean;
  exactMatch: boolean;
  expectedSql: string;
  actualSql: string;
  error?: string;
}

export interface FeedbackReplayReport {
  cases: number;
  passed: number;
  exactMatches: number;
  passRate: number;
  results: FeedbackReplayResult[];
}

/** Convert human corrections into a replayable regression corpus. */
export function buildFeedbackReplayCases(
  feedback: AnalysisFeedback[],
  options: { dialect?: string } = {},
): FeedbackReplayCase[] {
  return feedback
    .filter((record) => record.rating === "negative" && record.correctedSql && record.query)
    .map((record) => ({
      id: `FB-${record.id}`,
      sourceFeedbackId: record.id,
      query: record.query,
      expectedSql: record.correctedSql!,
      dialect: options.dialect ?? "sqlite",
    }));
}

export async function evaluateFeedbackReplay(
  cases: FeedbackReplayCase[],
  generateSql: FeedbackSqlGenerator,
): Promise<FeedbackReplayReport> {
  const results: FeedbackReplayResult[] = [];
  for (const replayCase of cases) {
    try {
      const actualSql = await generateSql({
        query: replayCase.query,
        dialect: replayCase.dialect,
      });
      const expected = normalizeReplaySql(replayCase.expectedSql);
      const actual = normalizeReplaySql(actualSql);
      results.push({
        id: replayCase.id,
        sourceFeedbackId: replayCase.sourceFeedbackId,
        passed: actual === expected,
        exactMatch: actual === expected,
        expectedSql: replayCase.expectedSql,
        actualSql,
      });
    } catch (error) {
      results.push({
        id: replayCase.id,
        sourceFeedbackId: replayCase.sourceFeedbackId,
        passed: false,
        exactMatch: false,
        expectedSql: replayCase.expectedSql,
        actualSql: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    cases: results.length,
    passed,
    exactMatches: results.filter((result) => result.exactMatch).length,
    passRate: results.length ? passed / results.length : 0,
    results,
  };
}

function normalizeReplaySql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
