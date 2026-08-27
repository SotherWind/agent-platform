import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import type { DataSourceRegistry } from "../datasource/registry.js";
import { routeDataSource } from "../datasource/router.js";

export interface DatasourceRoutingGoldenCase {
  id: string;
  query: string;
  expectedDataSourceId: string;
  preferredDataSourceId?: string;
}

export interface DatasourceRoutingGoldenSet {
  minimumTop1Accuracy: number;
  cases: DatasourceRoutingGoldenCase[];
}

export interface DatasourceRoutingEvalResult {
  id: string;
  expectedDataSourceId: string;
  actualDataSourceId: string | null;
  passed: boolean;
}

export function loadDatasourceRoutingGoldenSet(
  fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../tests/fixtures/evaluation/datasource-routing-golden.json",
  ),
): DatasourceRoutingGoldenSet {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as DatasourceRoutingGoldenSet;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error("Datasource routing golden set must contain cases");
  }
  if (!(parsed.minimumTop1Accuracy > 0 && parsed.minimumTop1Accuracy <= 1)) {
    throw new Error("minimumTop1Accuracy must be in (0, 1]");
  }
  return parsed;
}

export function evaluateDatasourceRouting(input: {
  goldenSet: DatasourceRoutingGoldenSet;
  principal: AuthenticatedPrincipal;
  policy: AccessPolicy;
  registry: DataSourceRegistry;
}) {
  const results: DatasourceRoutingEvalResult[] = input.goldenSet.cases.map(
    (goldenCase) => {
      const route = routeDataSource({
        query: goldenCase.query,
        principal: input.principal,
        policy: input.policy,
        registry: input.registry,
        preferredDataSourceId: goldenCase.preferredDataSourceId,
      });
      const actualDataSourceId = route.ok ? route.dataSourceId ?? null : null;
      return {
        id: goldenCase.id,
        expectedDataSourceId: goldenCase.expectedDataSourceId,
        actualDataSourceId,
        passed: actualDataSourceId === goldenCase.expectedDataSourceId,
      };
    },
  );
  const passed = results.filter((result) => result.passed).length;
  return {
    cases: results.length,
    passed,
    top1Accuracy: passed / results.length,
    minimumTop1Accuracy: input.goldenSet.minimumTop1Accuracy,
    results,
  };
}
