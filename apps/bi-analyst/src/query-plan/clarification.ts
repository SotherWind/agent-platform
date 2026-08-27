import { z } from "zod";

export const ClarificationRequestSchema = z.object({
  reason: z.enum([
    "ambiguous_metric",
    "ambiguous_datasource",
    "missing_time_range",
    "unauthorized_scope",
    "cross_source_query",
  ]),
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .optional(),
});

export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

export function parseClarificationRequest(
  input: unknown,
): ClarificationRequest {
  return ClarificationRequestSchema.parse(input);
}
