import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataSourceRegistryFromYaml } from "../../src/datasource/registry-loader.js";
import { createDefaultAccessPolicy } from "../../src/policy/access-policy.js";
import {
  evaluateDatasourceRouting,
  loadDatasourceRoutingGoldenSet,
} from "../../src/evaluation/datasource-routing.js";
import { createTestPrincipal } from "../helpers/principal.js";
import { section, test } from "../helpers/runner.js";

export async function testDatasourceRoutingEvaluation(): Promise<void> {
  section("Datasource routing Top-1 evaluation");

  await test("meets the 95% Top-1 acceptance threshold", () => {
    const appDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const registry = loadDataSourceRegistryFromYaml(
      path.join(appDir, "config/datasources.example.yaml"),
    );
    const principal = createTestPrincipal();
    const policy = createDefaultAccessPolicy(principal, [
      "ecommerce_sqlite",
      "sales_mysql",
      "sales_mariadb",
      "analytics_pg",
    ]);
    const report = evaluateDatasourceRouting({
      goldenSet: loadDatasourceRoutingGoldenSet(),
      principal,
      policy,
      registry,
    });
    assert.equal(report.cases, 20);
    assert.ok(
      report.top1Accuracy >= report.minimumTop1Accuracy,
      JSON.stringify(report.results.filter((result) => !result.passed)),
    );
  });
}
