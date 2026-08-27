/**
 * 本地开发冒烟：启动 test Profile API，跑一次 analyze + history。
 * 用法：pnpm smoke:local
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});
process.env.APP_ENV = "test";
process.env.BI_SQLITE_SYNC = "1";
process.env.USE_FAKE_EMBEDDINGS ??= "true";

import { bootstrapRuntime } from "../src/bootstrap/index.js";
import { createAppServer } from "../src/api/server.js";
import type { AddressInfo } from "node:net";

async function main() {
  const bootstrap = bootstrapRuntime({ APP_ENV: "test" });
  const app = createAppServer(bootstrap);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    "content-type": "application/json",
    "x-subject-id": "user-test",
    "x-tenant-id": "tenant-1",
  };

  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  console.info("[smoke] health", health.status, healthBody);

  const analyze = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "北京用户订单总额" }),
  });
  const analyzeBody = (await analyze.json()) as Record<string, unknown>;
  console.info(
    "[smoke] analyze",
    analyze.status,
    JSON.stringify(
      {
        finalAnswer: String(analyzeBody.finalAnswer ?? "").slice(0, 200),
        meta: analyzeBody.meta,
        needsClarification: analyzeBody.needsClarification,
        clarification: analyzeBody.clarification,
      },
      null,
      2,
    ),
  );

  const history = await fetch(`${base}/api/history?limit=5`, { headers });
  const historyBody = await history.json();
  console.info(
    "[smoke] history",
    history.status,
    Array.isArray(historyBody.items) ? historyBody.items.length : historyBody,
  );

  const ok =
    health.status === 200 &&
    analyze.status === 200 &&
    !analyzeBody.needsClarification &&
    Boolean(analyzeBody.finalAnswer) &&
    !String(analyzeBody.finalAnswer).includes("Execution error") &&
    !String(analyzeBody.finalAnswer).includes("执行失败") &&
    !String(analyzeBody.finalAnswer).includes("Formatting failed") &&
    !String(analyzeBody.finalAnswer).includes("Missing MODEL_API_KEY") &&
    (analyzeBody.meta as { dataFreshness?: { status?: string }; queryPath?: string })
      ?.dataFreshness?.status === "fresh" &&
    (analyzeBody.meta as { queryPath?: string }).queryPath === "metric";

  await app.close();

  if (!ok) {
    console.error("[smoke] FAILED");
    process.exit(1);
  }
  console.info("[smoke] OK — 本地全流程通过（认证→选源→指标→执行→答语→历史）");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
