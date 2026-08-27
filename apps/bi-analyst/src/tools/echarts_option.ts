import { ChartSpec, ChartType, ExecutionResult } from "../entities";

function baseTitle(title: string) {
  return { text: title, left: "center" as const };
}

function cartesianOption(
  chartType: "bar" | "line",
  title: string,
  categories: unknown[],
  valueColumns: string[],
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    title: baseTitle(title),
    tooltip: { trigger: "axis" },
    ...(valueColumns.length > 1
      ? { legend: { data: valueColumns, top: 30 } }
      : {}),
    grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
    xAxis: { type: "category", data: categories },
    yAxis: { type: "value" },
    series: valueColumns.map((col) => ({
      name: col,
      type: chartType,
      data: rows.map((row) => toChartValue(row[col])),
    })),
  };
}

function pieOption(
  title: string,
  dimCol: string,
  valueCol: string,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    title: baseTitle(title),
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    series: [
      {
        type: "pie",
        radius: "50%",
        data: rows.map((row) => ({
          name: String(row[dimCol]),
          value: toChartValue(row[valueCol]),
        })),
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };
}

function scatterOption(
  title: string,
  dimCol: string,
  valueColumns: string[],
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  if (valueColumns.length >= 2) {
    const [xCol, yCol] = valueColumns;
    return {
      title: baseTitle(title),
      tooltip: { trigger: "item" },
      xAxis: { type: "value", name: xCol },
      yAxis: { type: "value", name: yCol },
      series: [
        {
          type: "scatter",
          data: rows.map((row) => [toChartValue(row[xCol]), toChartValue(row[yCol])]),
        },
      ],
    };
  }

  const valueCol = valueColumns[0];
  return {
    title: baseTitle(title),
    tooltip: { trigger: "item" },
    xAxis: { type: "category", data: rows.map((row) => row[dimCol]) },
    yAxis: { type: "value", name: valueCol },
    series: [
      {
        type: "scatter",
        data: rows.map((row) => toChartValue(row[valueCol])),
      },
    ],
  };
}

function toChartValue(value: unknown): unknown {
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return value;
}

function tableSpec(
  title: string,
  columns: string[],
  rows: Record<string, unknown>[],
): ChartSpec {
  return {
    type: "table",
    title,
    dataset: {
      columns,
      rows: rows.map((row) => columns.map((col) => row[col])),
    },
  };
}

/** 将 SQL 执行结果转换为前端可直接使用的 ECharts option */
export function buildChartSpec(
  chartType: ChartType,
  title: string,
  data: ExecutionResult,
): ChartSpec {
  const { columns, rows } = data;

  if (data.isEmpty || columns.length === 0) {
    return tableSpec(title, [], []);
  }

  const [dimCol, ...valueColumns] = columns;

  if (valueColumns.length === 0) {
    return tableSpec(title, columns, rows);
  }

  const categories = rows.map((row) => row[dimCol]);

  switch (chartType) {
    case "bar":
    case "line":
      return {
        type: chartType,
        title,
        option: cartesianOption(
          chartType,
          title,
          categories,
          valueColumns,
          rows,
        ),
      };
    case "pie":
      return {
        type: "pie",
        title,
        option: pieOption(title, dimCol, valueColumns[0], rows),
      };
    case "scatter":
      return {
        type: "scatter",
        title,
        option: scatterOption(title, dimCol, valueColumns, rows),
      };
    case "table":
      return tableSpec(title, columns, rows);
  }
}
