import assert from "node:assert/strict";
import { test, section } from "../helpers/runner.js";
import { InMemoryAuditStore, redactAuditEvent } from "../../src/audit/store.js";
import { StoringAuditEmitter, createLocalAuditSink } from "../../src/audit/sink.js";
import { PermissionAwareQueryCache } from "../../src/cache/query-cache.js";
import { TenantRateLimiter } from "../../src/runtime/rate-limit.js";
import {
  sanitizeCsvCell,
  rowsToCsv,
  applyCsvWatermark,
  InMemoryExportJobStore,
} from "../../src/export/csv.js";
import { createDefaultModelRegistry } from "../../src/governance/model-registry.js";
import { InMemoryQueryHistoryStore } from "../../src/history/store.js";
import { SloRecorder, SloMonitor } from "../../src/runtime/slo.js";
import {
  encryptExportPayload,
  decryptExportPayload,
} from "../../src/export/encrypt.js";

export async function testPhaseEProductization() {
  section("Phase E 产品化（审计/缓存/限流/导出/模型）");

  await test("审计 store 持久化并可按租户查询", async () => {
    const store = new InMemoryAuditStore();
    const emitter = new StoringAuditEmitter(store, {
      emit() {},
    });
    emitter.emit({
      event: "request.accepted",
      requestId: "r1",
      traceId: "t1",
      subjectId: "u1",
      tenantId: "tenant-a",
    });
    emitter.emit({
      event: "answer.completed",
      requestId: "r1",
      traceId: "t1",
      subjectId: "u1",
      tenantId: "tenant-a",
    });
    emitter.emit({
      event: "request.accepted",
      requestId: "r2",
      traceId: "t2",
      subjectId: "u2",
      tenantId: "tenant-b",
    });
    const items = store.query({ tenantId: "tenant-a", limit: 10 });
    assert.equal(items.length, 2);
    assert.equal(items[0]!.event, "answer.completed");
    assert.equal(store.purgeOlderThan(0), 3);
  });

  await test("审计分页与字段分级脱敏", async () => {
    const store = new InMemoryAuditStore();
    for (let i = 0; i < 5; i += 1) {
      store.append({
        event: "sql.executed",
        requestId: `r${i}`,
        traceId: `t${i}`,
        subjectId: "u1",
        tenantId: "t1",
        dataSourceId: "ds-secret",
        timestamp: new Date(Date.now() + i).toISOString(),
        metadata: {
          generatedSql: "SELECT * FROM users",
          queryPath: "rag",
        },
      });
    }
    const page = store.query({ tenantId: "t1", limit: 2, offset: 1 });
    assert.equal(page.length, 2);
    assert.equal(page[0]!.requestId, "r3");

    const redacted = redactAuditEvent(page[0]!, "summary");
    assert.equal(redacted.dataSourceId, undefined);
    assert.equal(redacted.metadata?.generatedSql, undefined);
    assert.equal(redacted.metadata?.queryPath, "rag");
    assert.ok(redactAuditEvent(page[0]!, "full").metadata?.generatedSql);
  });

  await test("createLocalAuditSink 组合 emitter+store", async () => {
    const sink = createLocalAuditSink();
    assert.ok(sink.store);
    assert.ok(sink.emitter);
    sink.emitter!.emit({
      event: "policy.loaded",
      requestId: "r",
      traceId: "t",
      subjectId: "s",
      tenantId: "t1",
    });
    assert.equal(sink.store!.size(), 1);
  });

  await test("权限感知缓存命中与 policyVersion 隔离", async () => {
    const cache = new PermissionAwareQueryCache<string>();
    const parts = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "北京订单总额",
      metadataVersion: "2",
      metricVersion: "abc123",
    };
    const key = PermissionAwareQueryCache.buildKey(parts);
    cache.set(key, parts, "answer-a");
    assert.equal(cache.get(key, parts), "answer-a");
    assert.equal(
      cache.get(key, { ...parts, policyVersion: "v2" }),
      undefined,
    );
    assert.equal(
      cache.get(key, { ...parts, metadataVersion: "3" }),
      undefined,
    );
  });

  await test("metadataVersion 纳入 cache key", () => {
    const base = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "q",
    };
    const k1 = PermissionAwareQueryCache.buildKey({
      ...base,
      metadataVersion: "1",
    });
    const k2 = PermissionAwareQueryCache.buildKey({
      ...base,
      metadataVersion: "2",
    });
    assert.notEqual(k1, k2);
  });

  await test("invalidateByMetadataVersion 清空租户", () => {
    const cache = new PermissionAwareQueryCache<string>();
    const parts = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "q",
      metadataVersion: "1",
    };
    const key = PermissionAwareQueryCache.buildKey(parts);
    cache.set(key, parts, "x");
    assert.equal(cache.invalidateByMetadataVersion("t1", "2"), 1);
    assert.equal(cache.get(key, parts), undefined);
  });

  await test("invalidateTenant 清空租户缓存条目", async () => {
    const cache = new PermissionAwareQueryCache<string>();
    const a = {
      tenantId: "t1",
      subjectId: "u1",
      policyVersion: "v1",
      query: "q1",
    };
    const b = {
      tenantId: "t2",
      subjectId: "u2",
      policyVersion: "v1",
      query: "q2",
    };
    cache.set(PermissionAwareQueryCache.buildKey(a), a, "a");
    cache.set(PermissionAwareQueryCache.buildKey(b), b, "b");
    assert.equal(cache.invalidateTenant("t1"), 1);
    assert.equal(cache.get(PermissionAwareQueryCache.buildKey(a), a), undefined);
    assert.equal(cache.get(PermissionAwareQueryCache.buildKey(b), b), "b");
  });

  await test("租户限流超限返回 retryAfter", async () => {
    const limiter = new TenantRateLimiter(2, 60_000);
    assert.equal(limiter.check("t1").allowed, true);
    assert.equal(limiter.check("t1").allowed, true);
    const denied = limiter.check("t1");
    assert.equal(denied.allowed, false);
    assert.ok((denied.retryAfterMs ?? 0) > 0);
  });

  await test("CSV 注入防护 + 水印 + TTL", async () => {
    assert.equal(sanitizeCsvCell("=1+1"), "'=1+1");
    assert.equal(sanitizeCsvCell("+cmd"), "'+cmd");
    const csv = rowsToCsv(
      ["name", "note"],
      [{ name: "alice", note: "@SUM(A1)" }],
    );
    assert.ok(csv.includes("'@SUM(A1)"));
    const marked = applyCsvWatermark(csv, {
      tenantId: "t1",
      subjectId: "u1",
      requestId: "req-1",
      jobId: "exp-1",
      exportedAt: "2026-07-15T00:00:00.000Z",
    });
    assert.ok(marked.startsWith("# watermark tenant=t1"));

    const store = new InMemoryExportJobStore();
    const job = store.create({
      tenantId: "t1",
      subjectId: "u1",
      requestId: "req-1",
      columns: ["a"],
      rows: [{ a: "=hijack" }],
      ttlMs: 60_000,
    });
    assert.equal(job.status, "completed");
    assert.equal(job.encrypted, undefined);
    const { csv: downloaded } = store.takeDownload("t1", "u1", job.id);
    assert.ok(downloaded.includes("'=hijack"));
    assert.ok(downloaded.startsWith("# watermark"));
    const got = store.get("t1", "u1", job.id);
    assert.equal(got?.status, "expired");
    assert.equal(store.get("other", "u1", job.id), undefined);
  });

  await test("导出 AES 加密存储，下载时解密", async () => {
    const secret = "test-export-secret-32chars-minimum!!";
    const store = new InMemoryExportJobStore(secret);
    const job = store.create({
      tenantId: "t1",
      subjectId: "u1",
      requestId: "req-enc",
      columns: ["v"],
      rows: [{ v: "secret-data" }],
    });
    assert.equal(job.encrypted, true);
    assert.equal(job.csv, undefined);

    const plain = "city\n北京";
    const enc = encryptExportPayload(plain, secret);
    assert.notEqual(enc, plain);
    assert.equal(decryptExportPayload(enc, secret), plain);

    const { csv } = store.takeDownload("t1", "u1", job.id);
    assert.ok(csv.includes("secret-data"));
  });

  await test("导出审批：待批不可下载，批准后一次性下载", async () => {
    const store = new InMemoryExportJobStore();
    const job = store.create({
      tenantId: "t1",
      subjectId: "owner",
      requestId: "req-appr",
      columns: ["city"],
      rows: [{ city: "北京" }],
      requireApproval: true,
    });
    assert.equal(job.status, "pending_approval");
    assert.throws(
      () => store.takeDownload("t1", "owner", job.id),
      /待审批/,
    );

    const approved = store.approve("t1", job.id, "approver-1");
    assert.equal(approved.status, "completed");
    assert.equal(approved.approvedBy, "approver-1");

    const { csv, job: after } = store.takeDownload("t1", "owner", job.id);
    assert.ok(csv.includes("北京"));
    assert.equal(after.downloadCount, 1);
    assert.equal(after.status, "expired");
    assert.throws(
      () => store.takeDownload("t1", "owner", job.id),
      /下载次数已用尽|已过期|不可用/,
    );
  });

  await test("导出拒绝后不可下载且清除内容", async () => {
    const store = new InMemoryExportJobStore();
    const job = store.create({
      tenantId: "t1",
      subjectId: "owner",
      requestId: "req-rej",
      columns: ["x"],
      rows: [{ x: 1 }],
      requireApproval: true,
    });
    const rejected = store.reject("t1", job.id, "approver-1", "含敏感明细");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.csv, undefined);
    assert.throws(
      () => store.takeDownload("t1", "owner", job.id),
      /拒绝/,
    );
  });

  await test("模型版本预算门禁", async () => {
    const registry = createDefaultModelRegistry();
    const active = registry.getActive();
    assert.ok(active);
    assert.equal(registry.withinBudget(100), true);
    assert.equal(
      registry.withinBudget(active!.costBudgetTokensPerRequest + 1),
      false,
    );
  });

  await test("查询历史租户隔离、分页与慢查过滤", async () => {
    const hist = new InMemoryQueryHistoryStore();
    hist.append({
      id: "h1",
      tenantId: "t1",
      subjectId: "u1",
      requestId: "r1",
      traceId: "tr1",
      query: "q-fast",
      finalAnswerPreview: "ok",
      queryPath: "rag",
      needsClarification: false,
      createdAt: new Date().toISOString(),
      durationMs: 120,
      columns: ["c"],
      rows: [{ c: 1 }],
    });
    hist.append({
      id: "h2",
      tenantId: "t1",
      subjectId: "u1",
      requestId: "r2",
      traceId: "tr2",
      query: "q-slow",
      finalAnswerPreview: "ok",
      queryPath: "metric",
      needsClarification: false,
      createdAt: new Date().toISOString(),
      durationMs: 2500,
      columns: ["c"],
      rows: [{ c: 2 }],
    });
    const listed = hist.list("t1", "u1", 10);
    assert.equal(listed.length, 2);
    assert.equal("rows" in listed[0]!, false);
    assert.ok(hist.getByRequestId("t1", "u1", "r1")?.rows);
    assert.equal(hist.getByRequestId("t1", "u2", "r1"), undefined);

    const page = hist.list("t1", "u1", { limit: 1, offset: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0]!.requestId, "r1");

    const slow = hist.list("t1", "u1", { minDurationMs: 1000 });
    assert.equal(slow.length, 1);
    assert.equal(slow[0]!.requestId, "r2");
  });

  await test("模型 canary 灰度分流", async () => {
    const registry = createDefaultModelRegistry();
    registry.setActive("default-sql-v1");
    registry.setCanary({
      canaryVersionId: "default-sql-v2-canary",
      trafficPercent: 100,
    });
    const v = registry.resolveForSubject("user-canary");
    assert.equal(v?.id, "default-sql-v2-canary");

    registry.setCanary({
      canaryVersionId: "default-sql-v2-canary",
      trafficPercent: 0,
    });
    assert.equal(
      registry.resolveForSubject("user-canary")?.id,
      "default-sql-v1",
    );
  });

  await test("模型 promote / rollback", async () => {
    const registry = createDefaultModelRegistry();
    registry.setActive("default-sql-v1");
    registry.setCanary({
      canaryVersionId: "default-sql-v2-canary",
      trafficPercent: 10,
    });
    const promoted = registry.promoteCanary();
    assert.equal(promoted.id, "default-sql-v2-canary");
    assert.equal(registry.getCanary(), null);
    assert.equal(registry.getPreviousActive()?.id, "default-sql-v1");

    const rolled = registry.rollback();
    assert.equal(rolled.id, "default-sql-v1");
    assert.equal(registry.getActive()?.id, "default-sql-v1");
  });

  await test("WebhookAlertSink 构造与 ConsoleAlertSink", async () => {
    const { ConsoleAlertSink, createAlertSink } = await import(
      "../../src/runtime/alert-sink.js"
    );
    const sink = new ConsoleAlertSink();
    await sink.notify({
      kind: "error_rate",
      threshold: 0.05,
      actual: 0.2,
      at: new Date().toISOString(),
    });
    const composed = createAlertSink({});
    assert.ok(composed);
  });

  await test("SLO 监控超阈值触发告警", async () => {
    const fired: string[] = [];
    const monitor = new SloMonitor(
      new SloRecorder(),
      { maxErrorRate: 0.2, maxP95LatencyMs: 50, minSamples: 3 },
      (alert) => fired.push(alert.kind),
    );
    monitor.record({ durationMs: 10, success: true });
    monitor.record({ durationMs: 20, success: true });
    monitor.record({ durationMs: 100, success: false, code: "internal_error" });
    const snap = monitor.snapshot();
    assert.ok(snap.alerts.length >= 1);
    assert.ok(fired.includes("error_rate") || fired.includes("latency_p95"));
  });

  await test("SLO 记录器输出延迟分位与错误率", async () => {
    const slo = new SloRecorder();
    slo.record({ durationMs: 10, success: true });
    slo.record({ durationMs: 20, success: true });
    slo.record({ durationMs: 100, success: false, code: "rate_limited" });
    const snap = slo.snapshot();
    assert.equal(snap.requests, 3);
    assert.equal(snap.failures, 1);
    assert.ok(snap.errorRate > 0);
    assert.ok(snap.latencyMs.p95 >= snap.latencyMs.p50);
    assert.equal(snap.byCode.rate_limited, 1);
  });
}
