import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataSourceRegistryFromYaml } from "../src/datasource/registry-loader.js";
import { createDefaultAccessPolicy } from "../src/policy/access-policy.js";
import {
  evaluateDatasourceRouting,
  loadDatasourceRoutingGoldenSet,
} from "../src/evaluation/datasource-routing.js";
import { createTestPrincipal } from "../tests/helpers/principal.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

console.info(
  "[verify:routing]",
  JSON.stringify(
    {
      cases: report.cases,
      passed: report.passed,
      top1Accuracy: report.top1Accuracy,
      minimumTop1Accuracy: report.minimumTop1Accuracy,
      failed: report.results.filter((result) => !result.passed),
    },
    null,
    2,
  ),
);

if (report.top1Accuracy < report.minimumTop1Accuracy) process.exitCode = 1;
