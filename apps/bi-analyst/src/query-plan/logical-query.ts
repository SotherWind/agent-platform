import { z } from "zod";

export const FilterExpressionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "like"]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});

export const TimeGrainSchema = z.enum([
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);
export type TimeGrain = z.infer<typeof TimeGrainSchema>;

export const TimeGrainRequestSchema = z.object({
  field: z.string().min(1),
  grain: TimeGrainSchema,
});

export const LogicalQuerySchema = z.object({
  source: z.string().min(1),
  measures: z
    .array(
      z.object({
        ref: z.string().min(1),
        aggregation: z
          .enum(["sum", "count", "avg", "min", "max", "count_distinct"])
          .optional(),
      }),
    )
    .default([]),
  dimensions: z.array(z.object({ ref: z.string().min(1) })).default([]),
  filters: z.array(FilterExpressionSchema).default([]),
  timeRange: z
    .object({
      field: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1),
      timezone: z.string().default("Asia/Shanghai"),
    })
    .optional(),
  timeGrain: TimeGrainRequestSchema.optional(),
  orderBy: z
    .array(
      z.object({
        ref: z.string().min(1),
        direction: z.enum(["asc", "desc"]).default("asc"),
      }),
    )
    .optional(),
  limit: z.number().int().positive().max(10_000).optional(),
  metricId: z.string().optional(),
});

export type FilterExpression = z.infer<typeof FilterExpressionSchema>;
export type LogicalQuery = z.infer<typeof LogicalQuerySchema>;

export function parseLogicalQuery(input: unknown): LogicalQuery {
  return LogicalQuerySchema.parse(input);
}
