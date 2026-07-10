import { z } from "zod/v4";

export const RetrievedChunkSchema = z.object({
  id: z.string().describe("唯一标识"),
  documentId: z.string().describe("文档ID"),
  tenantId: z.string().describe("租户ID"),
  content: z.string().describe("chunk内容"),
  score: z.number().describe("相似性得分"),
  metadata: z.record(z.string(), z.unknown()).describe("元数据"),
});

export const RerankedChunkSchema = RetrievedChunkSchema.extend({
  rerankScore: z.number().describe("重排得分"),
});

export const AnswerCitationSchema = z.object({
  chunkId: z.string().describe("chunk ID"),
  documentId: z.string().describe("文档ID"),
  tenantId: z.string().describe("租户ID"),
  text: z.string().describe("引用原文"),
});

export const RetrieveContextToolInputSchema = z.object({
  query: z
    .string()
    .min(1, "query 不能为空")
    .describe("用户检索意图，用于向量相似度搜索"),
  tenantId: z
    .string()
    .min(1, "tenantId 不能为空")
    .describe("租户标识，检索时按此过滤，仅返回当前租户文档"),
  topK: z
    .number()
    .min(5, "topK 不能小于 5")
    .max(50, "topK 不能大于 50")
    .default(20)
    .describe("向量检索召回的候选 chunk 数量上限"),
  topN: z
    .number()
    .min(1, "topN 不能小于 1")
    .max(10, "topN 不能大于 10")
    .default(5)
    .describe("返回给调用方的 chunk 数量，须不大于 topK"),
}).refine((data) => data.topN <= data.topK, {
  message: "topN 不能大于 topK",
  path: ["topN"],
});

export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;
export type RerankedChunk = z.infer<typeof RerankedChunkSchema>;
export type AnswerCitation = z.infer<typeof AnswerCitationSchema>;
export type RetrieveContextToolInput = z.infer<typeof RetrieveContextToolInputSchema>;
