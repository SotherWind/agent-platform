import assert from "node:assert/strict";
import {
  inferTimeRangeFromQuery,
  resolveTimeRangePreset,
  timeRangeClarificationOptions,
} from "../../src/semantic/calendar.js";
import { test, section } from "../helpers/runner.js";

export async function testBusinessCalendar() {
  section("BusinessCalendar 财务周期 / 时间范围");

  const fixedNow = new Date("2026-07-16T08:00:00Z");
  const opts = { timezone: "Asia/Shanghai", now: fixedNow };

  await test("range.last_7d 含当天共 7 天", () => {
    const r = resolveTimeRangePreset("range.last_7d", opts)!;
    assert.equal(r.from, "2026-07-10");
    assert.equal(r.to, "2026-07-16");
  });

  await test("range.last_month 指向 6 月整月", () => {
    const r = resolveTimeRangePreset("range.last_month", opts)!;
    assert.equal(r.from, "2026-06-01");
    assert.equal(r.to, "2026-06-30");
  });

  await test("range.last_quarter 指向上季度", () => {
    // 2026-07 属 Q3 → 上季度 Q2
    const r = resolveTimeRangePreset("range.last_quarter", opts)!;
    assert.equal(r.from, "2026-04-01");
    assert.equal(r.to, "2026-06-30");
  });

  await test("range.this_quarter 从本季度起始到今天", () => {
    const r = resolveTimeRangePreset("range.this_quarter", opts)!;
    assert.equal(r.from, "2026-07-01");
    assert.equal(r.to, "2026-07-16");
  });

  await test("财年起始月=4 时本财年从 4/1", () => {
    const r = resolveTimeRangePreset("range.this_fiscal_year", {
      ...opts,
      fiscalYearStartMonth: 4,
    })!;
    assert.equal(r.from, "2026-04-01");
    assert.equal(r.to, "2026-07-16");
  });

  await test("上一财年边界正确", () => {
    const r = resolveTimeRangePreset("range.last_fiscal_year", {
      ...opts,
      fiscalYearStartMonth: 4,
    })!;
    assert.equal(r.from, "2025-04-01");
    assert.equal(r.to, "2026-03-31");
  });

  await test("自然语言推断上个月", () => {
    const r = inferTimeRangeFromQuery("查一下上个月订单总额", opts)!;
    assert.equal(r.preset, "range.last_month");
    assert.equal(r.from, "2026-06-01");
  });

  await test("自然语言推断本季度", () => {
    const r = inferTimeRangeFromQuery("查询张三本季度销售额", opts)!;
    assert.equal(r.preset, "range.this_quarter");
    assert.equal(r.from, "2026-07-01");
  });

  await test("澄清选项包含财年预设", () => {
    const ids = timeRangeClarificationOptions().map((o) => o.id);
    assert.ok(ids.includes("range.this_fiscal_year"));
    assert.ok(ids.includes("range.last_7d"));
  });
}
