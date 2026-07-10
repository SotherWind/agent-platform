import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import dotenv from "dotenv";
import { getLLM } from "@agent-platform/llm-sdk";
import { ChartTypeSchema, ExecutionResult } from "../entities";

dotenv.config();

const SuggestChartConfigInput = z.object({
  query: z.string().min(1).describe("用户的自然语言分析需求"),
  data: z.custom<ExecutionResult>().describe("SQL 执行结果"),
});

const ChartConfigOutputSchema = z.object({
  chartType: ChartTypeSchema.describe("最适合展示该数据的图表类型"),
  title: z.string().describe("图表标题，简洁中文，体现分析主题"),
  explanation: z.string().describe("选择该图表类型的简要理由"),
});

export const suggestChartConfigTool = tool(
  async ({ query, data }) => {
    const preview = {
      columns: data.columns,
      rowCount: data.rows.length,
      sampleRows: data.rows.slice(0, 5),
    };

    const prompt = `你是数据可视化专家。根据用户分析需求和查询结果，选择最合适的图表类型和标题。

用户需求：${query}

查询结果预览：
${JSON.stringify(preview, null, 2)}

可选图表类型：bar（分类对比）、line（时间趋势）、pie（占比构成）、table（明细表格）、scatter（两变量关系）

要求：
1. chartType 必须从上述类型中选择
2. title 使用简洁中文，直接反映分析主题
3. 时间序列优先 line，占比分析优先 pie，分类汇总优先 bar`;

    return getLLM()
      .withStructuredOutput(ChartConfigOutputSchema)
      .invoke(prompt);
  },
  {
    name: "suggest_chart_config",
    description: "根据分析需求和查询结果推荐图表类型与标题",
    schema: SuggestChartConfigInput,
  },
);
