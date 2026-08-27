import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });
// Test commands must remain isolated from a developer .env (which may set development).
process.env.APP_ENV = "test";
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
import { testDatasourceRoutingEvaluation } from "./evaluation/datasource-routing-eval.test";
import { testGoldenQueries } from "./integration/services/qdrant-metadata.test";
import { testQdrantMetadataIntegration } from "./integration/services/qdrant-metadata.test";
import { testE2eLocalApi } from "./e2e/local/api.test";
import { testE2eStagingRollout } from "./e2e/staging/rollout-drill.test";
import { testSqlAttackSet } from "./security/sql-attack.test";
import { testSecretProviderContract } from "./contract/secret-provider.test";
import { testSchemaRetrieverContract } from "./contract/schema-retriever.test";
import { testSqlExecutorContract } from "./contract/sql-executor.test";
import { testPolicyProvider } from "./unit/policy-provider.test";
import { testSqliteExplainCost } from "./unit/sqlite-explain-cost.test";
import { testRowFilterRewrite } from "./unit/row-filter.test";
import { testLogicalQuery } from "./unit/logical-query.test";
import { testMetricCompiler } from "./unit/metric-compiler.test";
import { testFreshnessInAnswer } from "./unit/freshness-answer.test";
import { testSessionPolicyInvalidation } from "./unit/session-policy.test";
import {
  testDialectAndRouter,
  testMysqlPgExecutorContract,
  testDialectConformance,
} from "./unit/dialect-router.test";
import { testPhaseEProductization } from "./unit/phase-e.test";
import { testAuditStoreContract } from "./unit/audit-store.test";
import { testPhaseFMetadata } from "./unit/phase-f-metadata.test";
import { testTextToSqlEval } from "./unit/text-to-sql-eval.test";
import { testTlsAndPrepareSql } from "./unit/tls-prepare-sql.test";
import { testJwtAuth } from "./unit/jwt-auth.test";
import { testLogicalQueryHash } from "./unit/logical-query-hash.test";
import { testBusinessCalendar } from "./unit/calendar.test";
import { testExecutorRegistry } from "./unit/executor-registry.test";
import { testMetadataSyncRunner } from "./unit/sync-runner.test";
import { testPhaseDRemaining } from "./unit/slow-query.test";
import { testClarificationResolver } from "./unit/clarification-resolver.test";
import { testQueryHistoryStoreContract } from "./unit/query-history-store.test";
import { testVaultSecretProvider } from "./unit/vault-secret.test";
import { testCloudSecretProviders } from "./unit/cloud-secret.test";
import { testRedisQueryCache } from "./unit/redis-query-cache.test";
import { testPostgresCheckpointer } from "./unit/postgres-checkpointer.test";
import { testMetadataSyncScheduler } from "./unit/sync-scheduler.test";
import { testPlannedDialects } from "./unit/planned-dialect.test";
import { testOracleSqlServerExecutors } from "./unit/oracle-sqlserver-executor.test";
import { testHttpPolicyProvider } from "./unit/http-policy-provider.test";
import { testAuditingSecretProvider } from "./unit/auditing-secret.test";
import { testArtifactBoundary } from "./unit/artifact-boundary.test";
import { testPersistentStateRecovery } from "./unit/persistent-state.test";
import {
  testOidcAndRetention,
  testSingleMachineStagingBootstrap,
} from "./unit/oidc-retention-staging.test";
import { testLiveDbExecutor } from "./integration/services/live-db-executor.test";
import { testLiveDbScanner } from "./integration/services/live-db-scanner.test";
import { testEnterpriseCapabilities } from "./unit/enterprise-capabilities.test";

const args = process.argv.slice(2);
/** 默认（无参数）运行 unit + contract + security，对齐计划「pnpm test」门禁 */
const runDefault = args.length === 0;
const runUnit =
  runDefault || args.includes("--unit") || args.includes("--all");
const runContract =
  runDefault || args.includes("--contract") || args.includes("--all");
const runSecurity =
  runDefault || args.includes("--security") || args.includes("--all");
const runIntegration =
  args.includes("--integration") ||
  args.includes("--integration-retry") ||
  args.includes("--all") ||
  process.env.RUN_INTEGRATION_TESTS === "1";
const runIntegrationServices =
  args.includes("--integration-services") ||
  args.includes("--all") ||
  process.env.RUN_INTEGRATION_SERVICES === "1";
const runLiveDb =
  args.includes("--live-db") || process.env.RUN_LIVE_DB_TESTS === "1";
const runEvaluation = args.includes("--evaluation") || args.includes("--all");
const runE2eLocal = args.includes("--e2e-local") || args.includes("--all");
const runE2eStaging =
  args.includes("--e2e-staging") || args.includes("--all");
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
    await testJwtAuth();
    await testOidcAndRetention();
    await testSingleMachineStagingBootstrap();
    await testVaultSecretProvider();
    await testCloudSecretProviders();
    await testPolicyProvider();
    await testResultPolicy();
    await testSchemaRag();
    await testExecuteCode();
    await testChartBuilding();
    await testShouldRetry();
    await testRetrySelfHealingFlow();
    await testMetadataIndexer();
    await testMetadataFreshness();
    await testFreshnessInAnswer();
    await testMetadataFactory();
    await testEmbeddingFactory();
    await testSessionStore();
    await testSessionPolicyInvalidation();
    await testSqliteCheckpointer();
    await testPostgresCheckpointer();
    await testSqliteExplainCost();
    await testRowFilterRewrite();
    await testLogicalQuery();
    await testLogicalQueryHash();
    await testMetricCompiler();
    await testBusinessCalendar();
    await testClarificationResolver();
    await testExecutorRegistry();
    await testDialectAndRouter();
    await testMysqlPgExecutorContract();
    await testDialectConformance();
    await testPlannedDialects();
    await testOracleSqlServerExecutors();
    await testHttpPolicyProvider();
    await testAuditingSecretProvider();
    await testArtifactBoundary();
    await testPersistentStateRecovery();
    await testEnterpriseCapabilities();
    await testPhaseDRemaining();
    await testPhaseEProductization();
    await testRedisQueryCache();
    await testAuditStoreContract();
    await testQueryHistoryStoreContract();
    await testTlsAndPrepareSql();
    await testPhaseFMetadata();
    await testMetadataSyncRunner();
    await testMetadataSyncScheduler();
    await testTextToSqlEval();
    await testGoldenQueries();
    await testSchemaRagEvaluation();
    await testDatasourceRoutingEvaluation();
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
    await testDatasourceRoutingEvaluation();
  }

  if (runE2eLocal) {
    await testE2eLocalApi();
  }

  if (runE2eStaging) {
    await testE2eStagingRollout();
  }

  if (runIntegrationServices) {
    await testQdrantMetadataIntegration(true);
    await testLiveDbScanner();
    await testLiveDbExecutor();
  }

  if (runLiveDb && !runIntegrationServices) {
    await testLiveDbScanner();
    await testLiveDbExecutor();
  }

  if (runIntegration) {
    if (!runIntegrationRetryOnly) {
      await testIntegration(true);
      await testSchemaRagIntegration();
    }
    await testIntegrationRetrySelfHealing(true);
  } else if (
    !runUnit &&
    !runE2eLocal &&
    !runE2eStaging &&
    !runContract &&
    !runSecurity &&
    !runIntegrationServices &&
    !runLiveDb &&
    !runEvaluation
  ) {
    console.log(
      "请指定 --unit、--contract、--security、--integration、--integration-services、--live-db、--integration-retry、--e2e-local、--e2e-staging、--evaluation 或 --all",
    );
    process.exit(1);
  } else if (runUnit) {
    await testIntegration(false);
    await testIntegrationRetrySelfHealing(false);
  }

  console.log("\n" + "=".repeat(50));
  console.log(
    `完成：${passed} 通过${skipped > 0 ? `，${skipped} 跳过` : ""}`,
  );
}

main().catch((err) => {
  console.error("\n测试失败：", err);
  process.exit(1);
});
