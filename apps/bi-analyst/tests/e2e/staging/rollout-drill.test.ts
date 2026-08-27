import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import { bootstrapStagingE2e } from "../../../src/bootstrap/staging-e2e-profile.js";
import { createAppServer } from "../../../src/api/server.js";
import { test, section } from "../../helpers/runner.js";

async function withStagingServer<T>(
  fn: (baseUrl: string, bootstrap: ReturnType<typeof bootstrapStagingE2e>) => Promise<T>,
): Promise<T> {
  const bootstrap = bootstrapStagingE2e();
  const app = createAppServer(bootstrap);
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl, bootstrap);
  } finally {
    await app.close();
  }
}

function roleHeaders(...roles: string[]): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-subject-id": "ops-admin",
    "x-tenant-id": "tenant-1",
    "x-roles": roles.join(","),
  };
}

export async function testE2eStagingRollout() {
  section("E2E Staging Rollout Drill");

  await test("GET /health 报告 staging 环境", async () => {
    await withStagingServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "ok");
      assert.equal(body.environment, "staging");
    });
  });

  await test("模型 canary → promote → rollback", async () => {
    await withStagingServer(async (baseUrl) => {
      const canary = await fetch(`${baseUrl}/api/models/canary`, {
        method: "POST",
        headers: roleHeaders("BI_MODEL_ADMIN"),
        body: JSON.stringify({
          canaryVersionId: "default-sql-v2-canary",
          trafficPercent: 50,
          confirm: "set-canary",
        }),
      });
      assert.equal(canary.status, 200);

      const promote = await fetch(`${baseUrl}/api/models/promote`, {
        method: "POST",
        headers: roleHeaders("BI_MODEL_ADMIN"),
        body: JSON.stringify({ confirm: "promote-model" }),
      });
      assert.equal(promote.status, 200);
      const promoted = await promote.json();
      assert.equal(promoted.active?.id, "default-sql-v2-canary");

      const rollback = await fetch(`${baseUrl}/api/models/rollback`, {
        method: "POST",
        headers: roleHeaders("BI_MODEL_ADMIN"),
        body: JSON.stringify({ confirm: "rollback-model" }),
      });
      assert.equal(rollback.status, 200);
      const rolled = await rollback.json();
      assert.equal(rolled.active?.id, "default-sql-v1");
      assert.equal(rolled.rollout?.activeId, "default-sql-v1");
    });
  });

  await test("metadata alias 切换后 HTTP 回滚", async () => {
    await withStagingServer(async (baseUrl, bootstrap) => {
      const indexer = bootstrap.profile.productization?.schemaIndexer;
      assert.ok(indexer);

      const docA = {
        id: "staging.users.city",
        docType: "column" as const,
        datasourceId: "ecommerce_sqlite",
        domain: "retail",
        dialectFamily: "sqlite" as const,
        table: "users",
        column: "city",
        reviewStatus: "approved" as const,
        content: "稳定索引：城市字段",
      };
      const first = await indexer.rebuildWithAliasSwap([docA]);
      const second = await indexer.rebuildWithAliasSwap([
        { ...docA, content: "坏索引：应被回滚" },
      ]);
      assert.ok(second.previousCollection);

      const response = await fetch(`${baseUrl}/api/metadata/alias/rollback`, {
        method: "POST",
        headers: roleHeaders("BI_METADATA_ADMIN"),
        body: JSON.stringify({
          previousCollection: second.previousCollection,
          confirm: "rollback-metadata-alias",
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.target, first.newCollection);
      assert.equal(await indexer.getAliasTarget(), first.newCollection);
    });
  });

  await test("debug role cannot cross administrative boundaries", async () => {
    await withStagingServer(async (baseUrl) => {
      const debugHeaders = roleHeaders("BI_QUERY_DEBUG");
      const requests = [
        fetch(`${baseUrl}/api/audit`, { headers: debugHeaders }),
        fetch(`${baseUrl}/api/models/canary`, {
          method: "POST",
          headers: debugHeaders,
          body: JSON.stringify({
            canaryVersionId: "default-sql-v2-canary",
            trafficPercent: 5,
            confirm: "set-canary",
          }),
        }),
        fetch(`${baseUrl}/api/metadata/describe`, {
          method: "POST",
          headers: debugHeaders,
          body: JSON.stringify({
            datasourceId: "ecommerce_sqlite",
            table: "users",
          }),
        }),
        fetch(`${baseUrl}/api/export/not-a-job/approve`, {
          method: "POST",
          headers: debugHeaders,
          body: JSON.stringify({ confirm: "approve-export" }),
        }),
      ];
      for (const response of await Promise.all(requests)) {
        assert.equal(response.status, 403);
      }

      const auditReader = await fetch(`${baseUrl}/api/audit`, {
        headers: roleHeaders("BI_AUDIT_READER"),
      });
      assert.equal(auditReader.status, 200);

      const exportApprover = await fetch(
        `${baseUrl}/api/export/not-a-job/approve`,
        {
          method: "POST",
          headers: roleHeaders("BI_EXPORT_APPROVER"),
          body: JSON.stringify({ confirm: "approve-export" }),
        },
      );
      assert.notEqual(exportApprover.status, 403);
    });
  });
}
