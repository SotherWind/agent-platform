import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestPrincipal } from "../helpers/principal.js";
import {
  FilePolicyProvider,
  InMemoryPolicyProvider,
} from "../../src/policy/policy-provider.js";
import { filterByPolicy } from "../../src/metadata/retriever-scoring.js";
import { DEMO_SCHEMA_DOCUMENTS } from "../../src/metadata/demo-documents.js";
import { test, section } from "../helpers/runner.js";

export async function testPolicyProvider() {
  section("PolicyProvider + 权限穿透 (B2/B4)");

  await test("InMemory 按 subject 加载策略与版本", () => {
    const provider = new InMemoryPolicyProvider([
      {
        subjectId: "user-restricted",
        tenantId: "tenant-1",
        policyVersion: "2",
        roles: ["viewer"],
        allowedDataSourceIds: ["ecommerce_sqlite"],
        allowedTables: ["users"],
        deniedTables: ["orders"],
      },
    ]);
    const policy = provider.loadPolicy(
      createTestPrincipal({ subjectId: "user-restricted", tenantId: "tenant-1" }),
    );
    assert.equal(policy.policyVersion, "2");
    assert.deepEqual(policy.allowedTables, ["users"]);
  });

  await test("FilePolicyProvider 从 JSON 加载", () => {
    const filePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../config/policies.example.json",
    );
    const provider = new FilePolicyProvider(filePath);
    const policy = provider.loadPolicy(
      createTestPrincipal({ subjectId: "user-restricted", tenantId: "tenant-1" }),
    );
    assert.equal(policy.policyVersion, "2");
    assert.deepEqual(policy.allowedTables, ["users"]);
  });

  await test("unknown tenants and subjects are denied by default", () => {
    const provider = new InMemoryPolicyProvider([
      {
        subjectId: "known-user",
        tenantId: "known-tenant",
        policyVersion: "1",
        roles: ["viewer"],
        allowedDataSourceIds: ["ecommerce_sqlite"],
      },
    ]);
    for (const principal of [
      createTestPrincipal({ subjectId: "unknown-user", tenantId: "known-tenant" }),
      createTestPrincipal({ subjectId: "known-user", tenantId: "unknown-tenant" }),
    ]) {
      assert.throws(
        () => provider.loadPolicy(principal),
        (error: { code?: string; statusCode?: number }) =>
          error.code === "forbidden" && error.statusCode === 403,
      );
    }
  });

  await test("filterByPolicy 拦截未授权表", () => {
    const policy = {
      subjectId: "u",
      tenantId: "t",
      policyVersion: "1",
      roles: ["viewer"],
      allowedDataSourceIds: ["ecommerce_sqlite", "test"],
      allowedTables: ["users"],
      deniedTables: ["orders"],
    };
    const filtered = filterByPolicy(DEMO_SCHEMA_DOCUMENTS, policy);
    assert.ok(filtered.every((d) => !d.table || d.table === "users" || d.docType === "datasource" || d.docType === "metric" || d.docType === "relation"));
    assert.ok(!filtered.some((d) => d.table === "orders"));
  });

  await test("filterByPolicy 拦截未授权列", () => {
    const policy = {
      subjectId: "u",
      tenantId: "t",
      policyVersion: "1",
      roles: ["viewer"],
      allowedDataSourceIds: ["ecommerce_sqlite"],
      allowedTables: ["users"],
      allowedColumns: { users: ["id", "city"] },
    };
    const filtered = filterByPolicy(DEMO_SCHEMA_DOCUMENTS, policy);
    const userColumns = filtered.filter(
      (d) => d.docType === "column" && d.table === "users",
    );
    assert.ok(userColumns.every((d) => ["id", "city"].includes(d.column!)));
    assert.ok(!userColumns.some((d) => d.column === "name"));
  });
}
