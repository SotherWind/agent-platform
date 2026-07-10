import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });
process.env.APP_ENV ??= "test";
process.env.BI_SQLITE_SYNC ??= "1";

import { passed, skipped } from "./helpers/runner";
import { testDatabase } from "./unit/database.test";
import { testExecuteCode } from "./unit/execute-code.test";
import { testChartBuilding } from "./unit/chart-building.test";
import { testShouldRetry } from "./unit/should-retry.test";
import { testRetrySelfHealingFlow } from "./unit/retry-self-healing.test";
import { testSqlValidator } from "./unit/sql-validator.test";
import { testSqlFailure } from "./unit/sql-failure.test";
import { testPrincipal } from "./unit/principal.test";
import { testResultPolicy } from "./unit/result-policy.test";
import { testSchemaRag } from "./unit/schema-rag.test";
import { testIntegration } from "./integration/graph.test";
import { testIntegrationRetrySelfHealing } from "./integration/retry-self-healing.test";
import { testSchemaRagIntegration } from "./integration/schema-rag.test";
import { testEnvConfig } from "./unit/env.test";
import { testRequestContext } from "./unit/request-context.test";
import { testBootstrap, testRegistry } from "./unit/bootstrap.test";
import { testMetadataIndexer } from "./unit/metadata-indexer.test";
import { testMetadataFreshness } from "./unit/freshness.test";
import { testMetadataFactory } from "./unit/metadata-factory.test";
import { testSessionStore } from "./unit/session-store.test";
import { testSqliteCheckpointer } from "./unit/sqlite-checkpointer.test";
import { testEmbeddingFactory } from "./unit/embedding-factory.test";
import { testSchemaRagEvaluation } from "./evaluation/schema-rag-eval.test";
import { testGoldenQueries } from "./integration/services/qdrant-metadata.test";
import { testQdrantMetadataIntegration } from "./integration/services/qdrant-metadata.test";
import { testE2eLocalApi } from "./e2e/local/api.test";
import { testSqlAttackSet } from "./security/sql-attack.test";
import { testSecretProviderContract } from "./contract/secret-provider.test";
import { testSchemaRetrieverContract } from "./contract/schema-retriever.test";
import { testSqlExecutorContract } from "./contract/sql-executor.test";

const args = process.argv.slice(2);
const runUnit = args.length === 0 || args.includes("--unit") || args.includes("--all");
const runContract = args.includes("--contract") || args.includes("--all");
const runSecurity = args.includes("--security") || args.includes("--all");
const runIntegration =
  args.includes("--integration") ||
  args.includes("--integration-retry") ||
  args.includes("--all") ||
  process.env.RUN_INTEGRATION_TESTS === "1";
const runIntegrationServices =
  args.includes("--integration-services") ||
  args.includes("--all") ||
  process.env.RUN_INTEGRATION_SERVICES === "1";
const runEvaluation = args.includes("--evaluation") || args.includes("--all");
const runE2eLocal = args.includes("--e2e-local") || args.includes("--all");
const runIntegrationRetryOnly = args.includes("--integration-retry");

async function main() {
  console.log("BI Analyst 测试套件");
  console.log("=".repeat(50));

  if (runUnit) {
    await testEnvConfig();
    await testRequestContext();
    await testBootstrap();
    await testRegistry();
    await testDatabase();
    await testSqlValidator();
    await testSqlFailure();
    await testPrincipal();
    await testResultPolicy();
    await testSchemaRag();
    await testExecuteCode();
    await testChartBuilding();
    await testShouldRetry();
    await testRetrySelfHealingFlow();
    await testMetadataIndexer();
    await testMetadataFreshness();
    await testMetadataFactory();
    await testEmbeddingFactory();
    await testSessionStore();
    await testSqliteCheckpointer();
    await testGoldenQueries();
    await testSchemaRagEvaluation();
  }

  if (runSecurity) {
    await testSqlAttackSet();
  }

  if (runContract) {
    await testSecretProviderContract();
    await testSchemaRetrieverContract();
    await testSqlExecutorContract();
  }

  if (runEvaluation && !runUnit) {
    await testSchemaRagEvaluation();
  }

  if (runE2eLocal) {
    await testE2eLocalApi();
  }

  if (runIntegrationServices) {
    await testQdrantMetadataIntegration(true);
  }

  if (runIntegration) {
    if (!runIntegrationRetryOnly) {
      await testIntegration(true);
      await testSchemaRagIntegration();
    }
    await testIntegrationRetrySelfHealing(true);
  } else if (!runUnit && !runE2eLocal && !runContract && !runSecurity && !runIntegrationServices && !runEvaluation) {
    console.log("请指定 --unit、--contract、--security、--integration、--integration-services、--integration-retry、--e2e-local、--evaluation 或 --all");
    process.exit(1);
  } else if (runUnit) {
    await testIntegration(false);
    await testIntegrationRetrySelfHealing(false);
  }

  console.log("\n" + "=".repeat(50));
  console.log(`完成：${passed} 通过${skipped > 0 ? `，${skipped} 跳过` : ""}`);
}

main().catch((err) => {
  console.error("\n测试失败：", err);
  process.exit(1);
});
