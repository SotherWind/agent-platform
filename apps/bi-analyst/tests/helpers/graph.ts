import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "../../src/agent";
import { generateSqlTool } from "../../src/tools/generate_sql";

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断 LLM API 是否为可重试的瞬时错误（404/429/5xx） */
function isRetriableApiError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string | number; lc_error_code?: string };
  const status = e.status ?? (typeof e.code === "number" ? e.code : Number(e.code));
  if ([404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (e.lc_error_code === "MODEL_NOT_FOUND") return true;
  const msg = String(err);
  return /upstream_error|rate.?limit|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
}

export async function invokeGraphWithRetry(
  graph: ReturnType<typeof buildGraph>,
  query: string,
  label: string,
  timeoutMs: number,
) {
  const maxAttempts = Number(process.env.INTEGRATION_API_RETRIES ?? 3);
  const retryDelayMs = Number(process.env.INTEGRATION_RETRY_DELAY_MS ?? 3000);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(
        graph.invoke(
          { messages: [new HumanMessage(query)] },
          { configurable: { thread_id: `integration-${label}` } },
        ),
        timeoutMs,
        label,
      );
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isRetriableApiError(err)) {
        console.log(`      ⚠ API 瞬时错误，${retryDelayMs}ms 后重试 (${attempt}/${maxAttempts})`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/** patch generateSqlTool：按序返回坏 SQL，耗尽后走 fallback */
export function patchSqlSequence(
  originalInvoke: typeof generateSqlTool.invoke,
  badSqlSequence: string[],
  fallback: "llm" | "always-bad" = "llm",
) {
  const capturedQueries: string[] = [];
  const failedSqls: string[] = [];
  let sqlGenCalls = 0;

  generateSqlTool.invoke = (async (input) => {
    sqlGenCalls++;
    const payload = input as { query: string };
    capturedQueries.push(payload.query);

    const badIdx = sqlGenCalls - 1;
    if (badIdx < badSqlSequence.length) {
      const sql = badSqlSequence[badIdx];
      failedSqls.push(sql);
      return sql;
    }

    if (fallback === "always-bad") {
      const sql = badSqlSequence[badSqlSequence.length - 1];
      failedSqls.push(sql);
      return sql;
    }

    return originalInvoke(input);
  }) as typeof generateSqlTool.invoke;

  return {
    get sqlGenCalls() { return sqlGenCalls; },
    capturedQueries,
    failedSqls,
  };
}
