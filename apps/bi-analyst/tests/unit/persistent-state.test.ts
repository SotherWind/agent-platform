import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, section } from "../helpers/runner.js";
import {
  createDefaultModelRegistry,
  PersistentModelVersionRegistry,
} from "../../src/governance/model-registry.js";
import { PersistentMetadataReviewStore } from "../../src/metadata/review.js";
import { InMemoryExportJobStore } from "../../src/export/csv.js";
import { InMemoryRedisCacheBackend } from "../../src/cache/redis-query-cache.js";
import { RedisSessionStore } from "../../src/session/redis-store.js";
import { RedisExportJobStore } from "../../src/export/redis-store.js";
import { RedisModelVersionRegistry } from "../../src/governance/redis-model-registry.js";
import { RedisMetadataReviewStore } from "../../src/metadata/redis-review-store.js";

export async function testPersistentStateRecovery() {
  section("Persistent state recovery");

  await test("model/review/export state survives a new process instance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bi-state-"));
    try {
      const modelPath = path.join(root, "model-registry.json");
      const firstModel = new PersistentModelVersionRegistry(modelPath);
      for (const version of createDefaultModelRegistry().list()) {
        firstModel.register(version);
      }
      firstModel.setActive("default-sql-v1");
      firstModel.setCanary({
        canaryVersionId: "default-sql-v2-canary",
        trafficPercent: 25,
      });
      const recoveredModel = new PersistentModelVersionRegistry(modelPath);
      assert.equal(recoveredModel.getActive()?.id, "default-sql-v1");
      assert.equal(recoveredModel.getCanary()?.trafficPercent, 25);

      const reviewPath = path.join(root, "metadata-review.json");
      const firstReview = new PersistentMetadataReviewStore(reviewPath);
      firstReview.upsertDraft({
        id: "doc-1",
        docType: "table",
        content: "orders",
        datasourceId: "sales_mysql",
        domain: "retail",
        dialectFamily: "mysql",
        table: "orders",
        reviewStatus: "draft",
      });
      const recoveredReview = new PersistentMetadataReviewStore(reviewPath);
      assert.equal(recoveredReview.get("doc-1")?.table, "orders");

      const exportPath = path.join(root, "export-jobs.json");
      const secret = "test-export-secret-32chars-minimum!!";
      const firstExports = new InMemoryExportJobStore({
        encryptionSecret: secret,
        persistencePath: exportPath,
      });
      const job = firstExports.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "persist-1",
        columns: ["value"],
        rows: [{ value: "persisted" }],
      });
      const recoveredExports = new InMemoryExportJobStore({
        encryptionSecret: secret,
        persistencePath: exportPath,
      });
      assert.equal(
        recoveredExports.get("t1", "u1", job.id)?.requestId,
        "persist-1",
      );
      assert.ok(
        recoveredExports
          .takeDownload("t1", "u1", job.id)
          .csv.includes("persisted"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test("Redis-backed production state is shared across instances", async () => {
    const backend = new InMemoryRedisCacheBackend();
    const principal = {
      tenantId: "tenant-a",
      subjectId: "analyst-a",
      roles: ["analyst"],
      claims: {},
    };

    const sessionsA = new RedisSessionStore(backend);
    const sessionsB = new RedisSessionStore(backend);
    await sessionsA.registerOrValidateAsync(principal, "session-a", "policy-v1");
    assert.equal(
      (await sessionsB.getAsync("tenant-a", "analyst-a", "session-a"))
        ?.policyVersion,
      "policy-v1",
    );

    const secret = "test-export-secret-32chars-minimum!!";
    const exportsA = new RedisExportJobStore(backend, secret);
    const exportsB = new RedisExportJobStore(backend, secret);
    const exportJob = await exportsA.createAsync({
      tenantId: "tenant-a",
      subjectId: "analyst-a",
      requestId: "request-a",
      columns: ["value"],
      rows: [{ value: "shared" }],
      requireApproval: true,
    });
    const approved = await exportsB.approveAsync(
      "tenant-a",
      exportJob.id,
      "approver-b",
    );
    assert.equal(approved.status, "completed");
    assert.ok(
      (
        await exportsA.takeDownloadAsync(
          "tenant-a",
          "analyst-a",
          exportJob.id,
        )
      ).csv.includes("shared"),
    );

    const defaults = createDefaultModelRegistry().list();
    const modelsA = new RedisModelVersionRegistry(backend, defaults);
    const modelsB = new RedisModelVersionRegistry(backend, defaults);
    await modelsA.initializeAsync();
    await modelsB.initializeAsync();
    await modelsA.setCanaryAsync({
      canaryVersionId: "default-sql-v2-canary",
      trafficPercent: 40,
    });
    await modelsB.refreshAsync();
    assert.equal(modelsB.getCanary()?.trafficPercent, 40);
    await modelsB.promoteCanaryAsync();
    await modelsA.refreshAsync();
    assert.equal(modelsA.getActive()?.id, "default-sql-v2-canary");

    const reviewsA = new RedisMetadataReviewStore(backend);
    const reviewsB = new RedisMetadataReviewStore(backend);
    await reviewsA.upsertDraftAsync({
      id: "redis-doc-1",
      docType: "table",
      content: "orders",
      datasourceId: "sales_mysql",
      domain: "retail",
      dialectFamily: "mysql",
      table: "orders",
      reviewStatus: "pending",
    });
    await reviewsB.decideAsync("redis-doc-1", {
      status: "approved",
      reviewedBy: "reviewer-b",
    });
    assert.equal(
      (await reviewsA.getAsync("redis-doc-1"))?.reviewStatus,
      "approved",
    );
  });
}
