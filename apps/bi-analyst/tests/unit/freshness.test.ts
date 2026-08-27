import assert from "node:assert/strict";
import { computeMetadataFreshness } from "../../src/metadata/freshness.js";
import type { SchemaDocument } from "../../src/metadata/types.js";
import { test, section } from "../helpers/runner.js";

const BASE_DOC: SchemaDocument = {
  id: "test.orders",
  docType: "table",
  datasourceId: "test",
  domain: "retail",
  dialectFamily: "sqlite",
  table: "orders",
  reviewStatus: "approved",
  content: "订单表",
  sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
  indexedAt: "2026-07-09T12:00:00.000Z",
  schemaVersion: "1",
};

export async function testMetadataFreshness() {
  section("元数据新鲜度 (computeMetadataFreshness)");

  await test("有 sourceUpdatedAt 时返回 fresh", () => {
    const meta = computeMetadataFreshness([BASE_DOC], {
      now: new Date("2026-07-09T15:00:00.000Z"),
    });
    assert.equal(meta.status, "fresh");
    assert.equal(meta.dataAsOf, "2026-07-09T10:00:00.000Z");
    assert.equal(meta.timezone, "Asia/Shanghai");
  });

  await test("超过 stale 阈值标记 stale", () => {
    const meta = computeMetadataFreshness([BASE_DOC], {
      now: new Date("2026-07-11T10:00:00.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(meta.status, "stale");
    assert.ok(meta.warnings.some((w) => /超过/.test(w)));
  });

  await test("无文档时 status=unknown", () => {
    const meta = computeMetadataFreshness([]);
    assert.equal(meta.status, "unknown");
    assert.ok(meta.warnings.length > 0);
  });

  await test("多 schemaVersion 产生 warning", () => {
    const meta = computeMetadataFreshness([
      BASE_DOC,
      { ...BASE_DOC, id: "test.users", schemaVersion: "2" },
    ]);
    assert.ok(meta.warnings.some((w) => /schemaVersion/.test(w)));
  });

  await test("indexedAt fallback remains transparent", () => {
    const meta = computeMetadataFreshness(
      [{ ...BASE_DOC, sourceUpdatedAt: undefined }],
      { now: new Date("2026-07-09T15:00:00.000Z") },
    );
    assert.equal(meta.status, "fresh");
    assert.equal(meta.dataAsOf, "2026-07-09T12:00:00.000Z");
    assert.ok(meta.warnings.some((w) => /sourceUpdatedAt/.test(w)));
  });
}
