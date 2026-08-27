/**
 * Schema RAG 评测门禁：对齐 ENTERPRISE-PLAN 最低质量门槛（本地 golden 集）。
 * 用法：pnpm verify:eval-gate
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});
process.env.APP_ENV ??= "test";

import { createTestPrincipal } from "../tests/helpers/principal.js";
import { createDefaultAccessPolicy } from "../src/policy/access-policy.js";
import { createDemoRetriever } from "../src/metadata/demo-documents.js";
import { evaluateGoldenQuerySet } from "../src/metadata/evaluation.js";
import { loadGoldenQueries } from "../tests/helpers/golden-queries.js";

const THRESHOLDS = {
  passRate: 1,
  avgTableRecall: 0.98,
  avgColumnRecall: 0.97,
  forbiddenLeakMax: 0,
};

async function main() {
  const goldenQueries = loadGoldenQueries();
  const principal = createTestPrincipal({ tenantId: "tenant-1" });
  const policy = createDefaultAccessPolicy(principal, ["ecommerce_sqlite"]);
  const retriever = createDemoRetriever();

  const { results, passRate, avgTableRecall, avgColumnRecall } =
    await evaluateGoldenQuerySet(retriever, goldenQueries, policy);

  const forbiddenLeaks = results.reduce(
    (sum, r) => sum + r.forbiddenLeaks.length,
    0,
  );

  const report = {
    cases: results.length,
    passRate,
    avgTableRecall,
    avgColumnRecall,
    forbiddenLeaks,
    thresholds: THRESHOLDS,
    failed: results.filter((r) => !r.passed).map((r) => r.id),
  };

  console.info("[verify:eval-gate]", JSON.stringify(report, null, 2));

  const ok =
    passRate >= THRESHOLDS.passRate &&
    avgTableRecall >= THRESHOLDS.avgTableRecall &&
    avgColumnRecall >= THRESHOLDS.avgColumnRecall &&
    forbiddenLeaks <= THRESHOLDS.forbiddenLeakMax;

  if (!ok) {
    console.error("评测门禁未通过");
    process.exit(1);
  }
  console.info("评测门禁通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
