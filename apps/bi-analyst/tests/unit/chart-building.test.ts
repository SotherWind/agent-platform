import assert from "node:assert/strict";
import { formatChartTool } from "../../src/tools/format_chart";
import { buildChartSpec } from "../../src/tools/echarts_option";
import type { ExecutionResult } from "../../src/entities";
import { test, section } from "../helpers/runner";
import { sampleRows } from "../helpers/fixtures";

export async function testChartBuilding() {
  section("图表构建 (buildChartSpec / formatChartTool)");

  await test("bar 图：生成 ECharts option", () => {
    const spec = buildChartSpec("bar", "各城市销售额", sampleRows);
    assert.equal(spec.type, "bar");
    assert.equal(spec.title, "各城市销售额");
    assert.ok(spec.option);
    assert.equal((spec.option!.xAxis as { type: string }).type, "category");
    assert.ok(Array.isArray((spec.option!.series as unknown[])));
  });

  await test("line 图：series 类型为 line", () => {
    const spec = buildChartSpec("line", "趋势", sampleRows);
    assert.equal(spec.type, "line");
    const series = spec.option!.series as { type: string }[];
    assert.equal(series[0].type, "line");
  });

  await test("pie 图：data 项数与行数一致", () => {
    const spec = buildChartSpec("pie", "城市占比", sampleRows);
    assert.equal(spec.type, "pie");
    const series = spec.option!.series as { data: unknown[] }[];
    assert.equal(series[0].data.length, 3);
  });

  await test("scatter 图（双数值列）：生成 [x,y] 坐标", () => {
    const scatterData: ExecutionResult = {
      columns: ["month", "order_count", "total_amount"],
      rows: [
        { month: "2024-01", order_count: 2, total_amount: 450.49 },
        { month: "2024-02", order_count: 2, total_amount: 1049.0 },
      ],
      isEmpty: false,
    };
    const spec = buildChartSpec("scatter", "订单散点", scatterData);
    assert.equal(spec.type, "scatter");
    const series = spec.option!.series as { data: unknown[] }[];
    assert.equal(series[0].data.length, 2);
    assert.ok(Array.isArray(series[0].data[0]));
  });

  await test("table 类型：dataset 行列对齐", () => {
    const spec = buildChartSpec("table", "明细表", sampleRows);
    assert.equal(spec.type, "table");
    assert.deepEqual(spec.dataset!.columns, ["city", "total_amount"]);
    assert.equal(spec.dataset!.rows.length, 3);
    assert.equal(spec.dataset!.rows[0][0], "北京");
  });

  await test("空数据：降级为空 table", () => {
    const empty: ExecutionResult = { columns: [], rows: [], isEmpty: true };
    const spec = buildChartSpec("bar", "空结果", empty);
    assert.equal(spec.type, "table");
    assert.deepEqual(spec.dataset, { columns: [], rows: [] });
  });

  await test("单列数据：降级为 table", () => {
    const singleCol: ExecutionResult = {
      columns: ["city"],
      rows: [{ city: "北京" }, { city: "上海" }],
      isEmpty: false,
    };
    const spec = buildChartSpec("bar", "仅维度列", singleCol);
    assert.equal(spec.type, "table");
    assert.equal(spec.dataset!.rows.length, 2);
  });

  await test("formatChartTool：与 buildChartSpec 结果一致", async () => {
    const spec = await formatChartTool.invoke({
      data: sampleRows,
      chartType: "bar",
      title: "工具封装测试",
    });
    assert.equal(spec.type, "bar");
    assert.equal(spec.title, "工具封装测试");
    assert.ok(spec.option);
  });
}
