// src/tools/format_chart.ts
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ExecutionResult, ChartSpec, ChartTypeSchema } from "../entities";
import { buildChartSpec } from "./echarts_option";

const FormatChartInput = z.object({
  data: z.custom<ExecutionResult>(),
  chartType: ChartTypeSchema,
  title: z.string().optional(),
});

export type FormatChartInput = z.infer<typeof FormatChartInput>;

export const formatChartTool = tool(
  async (input): Promise<ChartSpec> => {
    const { data, chartType, title } = FormatChartInput.parse(input);
    return buildChartSpec(chartType, title || "Analysis Result", data);
  },
  { name: "format_chart", description: "格式化图表", schema: FormatChartInput },
);
