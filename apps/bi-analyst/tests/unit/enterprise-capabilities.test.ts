import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, section } from "../helpers/runner.js";
import {
  InMemoryAnalysisFeedbackStore,
  PersistentAnalysisFeedbackStore,
} from "../../src/governance/feedback.js";
import {
  buildFeedbackReplayCases,
  evaluateFeedbackReplay,
} from "../../src/governance/feedback-eval.js";
import {
  AnalysisJobRunner,
  InMemoryAnalysisJobStore,
  PersistentAnalysisJobStore,
} from "../../src/runtime/analysis-jobs.js";
import { Telemetry, parseTraceParent } from "../../src/runtime/telemetry.js";
import { MetricRegistry } from "../../src/semantic/metric-registry.js";
import { compileCertifiedMetric } from "../../src/semantic/sql-compiler.js";

export async function testEnterpriseCapabilities() {
  section("Enterprise feedback, jobs, telemetry and metric governance");

  await test("feedback enforces correction context and tenant isolation", () => {
    const store = new InMemoryAnalysisFeedbackStore();
    assert.throws(() =>
      store.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "r1",
        query: "sales",
        rating: "negative",
      }),
    );
    const saved = store.create({
      tenantId: "t1",
      subjectId: "u1",
      requestId: "r1",
      query: "sales",
      rating: "negative",
      correctedSql: "SELECT SUM(amount) FROM orders",
      categories: ["wrong_metric", "wrong_metric"],
    });
    assert.equal(store.get("t1", "u1", saved.id)?.rating, "negative");
    assert.equal(store.get("t1", "u2", saved.id), undefined);
    assert.deepEqual(store.listInTenant("t1")[0]?.categories, ["wrong_metric"]);
  });

  await test("feedback survives persistence and becomes replay corpus", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bi-feedback-"));
    try {
      const file = path.join(root, "feedback.json");
      const secret = "test-feedback-encryption-secret-32chars!!";
      const first = new PersistentAnalysisFeedbackStore(file, secret);
      const saved = first.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "r1",
        query: "total sales",
        rating: "negative",
        correctedSql: "SELECT SUM(amount) FROM orders",
      });
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /total sales|SELECT SUM/);
      assert.throws(() => new PersistentAnalysisFeedbackStore(file));
      const recovered = new PersistentAnalysisFeedbackStore(file, secret);
      const cases = buildFeedbackReplayCases(recovered.listInTenant("t1"));
      assert.equal(cases.length, 1);
      assert.equal(cases[0]?.sourceFeedbackId, saved.id);
      return evaluateFeedbackReplay(cases, async () => "SELECT SUM(amount) FROM orders").then((report) => {
        assert.equal(report.passRate, 1);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test("analysis jobs persist and runner completes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bi-jobs-"));
    try {
      const file = path.join(root, "jobs.json");
      const secret = "test-job-encryption-secret-32-characters!!";
      const store = new PersistentAnalysisJobStore(file, secret);
      const runner = new AnalysisJobRunner(store, 1);
      const job = store.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "r1",
        traceId: "trace-1",
        query: "sales",
      });
      runner.enqueue(job.id, async () => ({ finalAnswer: "ok" }));
      for (let i = 0; i < 50 && store.get("t1", "u1", job.id)?.status !== "completed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(store.get("t1", "u1", job.id)?.status, "completed");
      assert.deepEqual(store.get("t1", "u1", job.id)?.result, { finalAnswer: "ok" });
      await runner.close();
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /finalAnswer|sales/);
      assert.throws(() => new PersistentAnalysisJobStore(file));
      assert.equal(new PersistentAnalysisJobStore(file, secret).get("t1", "u1", job.id)?.status, "completed");

      const restartFile = path.join(root, "restart-jobs.json");
      const beforeRestart = new PersistentAnalysisJobStore(restartFile, secret);
      const interrupted = beforeRestart.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "r2",
        traceId: "trace-2",
        query: "orders by city",
      });
      const afterRestart = new PersistentAnalysisJobStore(restartFile, secret);
      assert.equal(afterRestart.get("t1", "u1", interrupted.id)?.status, "failed");
      assert.match(afterRestart.get("t1", "u1", interrupted.id)?.error ?? "", /restart/i);

      const queuedFile = path.join(root, "queued-cancel.json");
      const queuedStore = new PersistentAnalysisJobStore(queuedFile, secret);
      const blocker = queuedStore.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "r3",
        traceId: "trace-3",
        query: "blocking job",
      });
      const queued = queuedStore.create({
        tenantId: "t1",
        subjectId: "u1",
        requestId: "r4",
        traceId: "trace-4",
        query: "queued cancellation",
      });
      const queuedRunner = new AnalysisJobRunner(queuedStore, 1);
      queuedRunner.enqueue(blocker.id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { finalAnswer: "blocker" };
      });
      queuedRunner.enqueue(queued.id, async () => ({ finalAnswer: "must not run" }));
      queuedStore.cancel("t1", "u1", queued.id);
      for (
        let i = 0;
        i < 50 && queuedStore.get("t1", "u1", blocker.id)?.status !== "completed";
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(queuedStore.get("t1", "u1", queued.id)?.status, "cancelled");
      await queuedRunner.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test("telemetry keeps trace context and exports a bounded snapshot", () => {
    const telemetry = new Telemetry({ maxSpans: 100 });
    const parent = telemetry.startSpan("request");
    const child = telemetry.startSpan("db.query", { "db.system": "sqlite" }, parent);
    child.setAttribute("db.rows", 3);
    child.end();
    parent.end();
    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.spans.length, 2);
    const root = snapshot.spans.find((span) => span.name === "request");
    const childSpan = snapshot.spans.find((span) => span.name === "db.query");
    assert.equal(childSpan?.traceId, root?.traceId);
    assert.equal(root?.parentSpanId, undefined);
    assert.equal(parseTraceParent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"), "0123456789abcdef0123456789abcdef");
  });

  await test("metric registry detects dependency errors and compiles safe formulas", () => {
    const base = {
      metric: "base_metric",
      version: 1,
      label: "Base",
      datasourceId: "ds",
      status: "certified" as const,
      owner: "bi",
      factTable: "orders",
      entityKey: "id",
      measure: { field: "amount", aggregation: "sum" as const, additive: true },
      timeDimension: "created_at",
      timezone: "UTC",
      unit: "CNY",
      defaultFilters: [],
      dimensions: [],
      synonyms: [],
      joinGraph: [],
      freshnessSlaHours: 24,
      requireTimeRange: false,
      dependsOn: [],
    };
    const derived = {
      ...base,
      metric: "derived_metric",
      label: "Derived",
      measure: { field: "amount", aggregation: "sum" as const, additive: true },
      formula: "base_metric / base_metric",
      dependsOn: ["base_metric"],
    };
    const registry = MetricRegistry.fromDefinitions([base, derived]);
    assert.equal(registry.validateGovernance().filter((issue) => issue.severity === "error").length, 0);
    const compiled = compileCertifiedMetric({ metric: derived, registry });
    assert.equal(compiled.ok, true, compiled.reason);
    assert.match(compiled.sql!, /SUM/);
    assert.match(compiled.sql!, /NULLIF/);
    assert.match(compiled.sql!, /derived_metric/);
  });
}
