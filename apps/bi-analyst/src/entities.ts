import { z } from "zod";
import type { SqlFailureKind } from "./errors/sql-failure.js";

export const DataTableSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          description: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type DataTable = z.infer<typeof DataTableSchema>;

export const ExecutionResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.any())),
  columns: z.array(z.string()),
  stats: z
    .object({
      durationMs: z.number(),
      rowCount: z.number(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  /** Result policy changed the returned shape or payload size. */
  degraded: z.boolean().optional(),
  degradationReasons: z.array(z.string()).optional(),
  error: z.string().nullable().optional(),
  /** 脱敏后的失败分类，供重试路由使用 */
  failureKind: z
    .enum([
      "syntax_error",
      "unknown_table",
      "unknown_column",
      "permission_denied",
      "timeout",
      "cost_rejected",
      "policy_rejected",
      "connection_error",
      "unknown",
    ])
    .optional(),
  isEmpty: z.boolean(),
});

export type { SqlFailureKind };
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ChartTypeSchema = z.enum([
  "bar",
  "line",
  "pie",
  "table",
  "scatter",
]);
export type ChartType = z.infer<typeof ChartTypeSchema>;

export const ChartSpecSchema = z.object({
  type: ChartTypeSchema,
  title: z.string(),
  /** ECharts setOption 可直接使用的配置，table 类型为 undefined */
  option: z.record(z.string(), z.any()).optional(),
  /** table 类型的表格数据 */
  dataset: z
    .object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.any())),
    })
    .optional(),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;
