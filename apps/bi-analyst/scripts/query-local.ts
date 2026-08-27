#!/usr/bin/env tsx
/** Local query runner for the single-machine staging API. */

type AnalyzeBody = {
  meta?: {
    queryPath?: string;
    cacheHit?: boolean;
    dataSourceId?: string;
  };
  debugMeta?: {
    generatedSql?: string;
    dataSourceId?: string;
  };
  needsClarification?: boolean;
  clarification?: unknown;
  finalAnswer?: unknown;
};

function parseArgs(args: string[]): {
  query: string;
  clarificationChoice?: string;
} {
  const queryParts: string[] = [];
  let clarificationChoice: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg === "--datasource") {
      const value = args[++i];
      if (!value) throw new Error("--datasource 需要数据源 ID");
      clarificationChoice = value.startsWith("datasource.")
        ? value
        : `datasource.${value}`;
      continue;
    }
    if (arg.startsWith("--datasource=")) {
      const value = arg.slice("--datasource=".length);
      if (!value) throw new Error("--datasource 需要数据源 ID");
      clarificationChoice = value.startsWith("datasource.")
        ? value
        : `datasource.${value}`;
      continue;
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error(
      '用法：pnpm query:local -- "自然语言问题" [--datasource sales_mysql]',
    );
  }
  return { query, clarificationChoice };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const { query, clarificationChoice } = parseArgs(process.argv.slice(2));
  const baseUrl = (
    process.env.BI_LOCAL_BASE_URL ?? "http://127.0.0.1:13000"
  ).replace(/\/$/, "");
  const subjectId = process.env.BI_LOCAL_SUBJECT_ID ?? "user-local";
  const tenantId = process.env.BI_LOCAL_TENANT_ID ?? "tenant-1";

  const health = await fetch(`${baseUrl}/health`);
  if (!health.ok) {
    throw new Error(`本地服务不可用：HTTP ${health.status}`);
  }

  const tokenResponse = await fetch(`${baseUrl}/api/staging/mock-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subjectId,
      tenantId,
      roles: ["analyst", "BI_QUERY_DEBUG", "BI_AUDIT_READER"],
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`无法取得本地 staging token：HTTP ${tokenResponse.status}`);
  }
  const tokenBody = await readJson<{ access_token?: string }>(tokenResponse);
  if (!tokenBody.access_token) throw new Error("本地 staging token 响应缺少 access_token");

  const requestBody: { query: string; clarificationChoice?: string } = { query };
  if (clarificationChoice) requestBody.clarificationChoice = clarificationChoice;

  const response = await fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const body = await readJson<AnalyzeBody>(response);

  console.log(
    JSON.stringify(
      {
        status: response.status,
        query,
        queryPath: body.meta?.queryPath,
        cacheHit: body.meta?.cacheHit ?? false,
        needsClarification: body.needsClarification ?? false,
        clarification: body.clarification,
        dataSourceId:
          body.debugMeta?.dataSourceId ?? body.meta?.dataSourceId,
        generatedSql: body.debugMeta?.generatedSql,
        finalAnswer: body.finalAnswer,
      },
      null,
      2,
    ),
  );

  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("query:local 失败：", error);
  process.exitCode = 1;
});
