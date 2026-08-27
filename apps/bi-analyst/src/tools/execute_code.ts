// src/tools/execute_code.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { SqlExecutor } from "../datasource/types.js";
import { createExecutor } from "../datasource/executors/index.js";
import {
  applyResultPolicy,
  extractAggregationCountColumns,
  isAggregationQuery,
} from "../policy/result-policy.js";
import type { AccessPolicy } from "../policy/access-policy.js";

const ExecuteCodePayload = z.object({
  sql: z.string().min(1).describe("要执行的 SQL 语句"),
  executionContext: z.object({
    dataSourceId: z.string().describe("数据源标识"),
    tenantId: z.string().describe("租户 ID"),
    subjectId: z.string().optional().describe("用户 ID"),
    sessionId: z.string().optional().describe("会话 ID"),
    requestId: z.string().optional().describe("请求 ID"),
    timeoutMs: z.number().positive().describe("超时时间（毫秒）"),
    params: z.array(z.union([z.string(), z.number()])).optional(),
  }),
  expectedFormat: z.enum(["table", "chart-ready"]),
});

export interface ExecuteCodeToolOptions {
  accessPolicy?: AccessPolicy | null;
  maxRows?: number;
}

export function createExecuteCodeTool(
  executorOrDb: SqlExecutor | { prepare: (sql: string) => unknown; name?: string; close?: () => void },
  options: ExecuteCodeToolOptions = {},
) {
  const executor: SqlExecutor =
    "execute" in executorOrDb
      ? executorOrDb
      : createExecutor({ db: executorOrDb as never });

  return tool(
    async (payload) => {
      const { sql, executionContext } = ExecuteCodePayload.parse(payload);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        executionContext.timeoutMs,
      );

      try {
        const raw = await executor.execute(
          {
            sql,
            dataSourceId: executionContext.dataSourceId,
            tenantId: executionContext.tenantId,
            subjectId: executionContext.subjectId,
            sessionId: executionContext.sessionId,
            requestId: executionContext.requestId,
            timeoutMs: executionContext.timeoutMs,
            maxRows: options.maxRows,
            allowedTables: options.accessPolicy?.allowedTables,
            allowedColumns: options.accessPolicy?.allowedColumns,
            deniedColumns: options.accessPolicy?.deniedColumns,
            rowFilters: options.accessPolicy?.rowFilters,
            params: executionContext.params,
          },
          controller.signal,
        );

        return applyResultPolicy(raw, {
          accessPolicy: options.accessPolicy,
          options: {
            minAggregationCount: options.accessPolicy?.minAggregationCount,
            aggregationCountColumns: extractAggregationCountColumns(sql),
            enforceAggregationCount:
              options.accessPolicy?.minAggregationCount !== undefined &&
              isAggregationQuery(sql),
          },
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      name: "execute_code",
      description: "执行 SQL 查询并返回结构化结果",
      schema: ExecuteCodePayload,
    },
  );
}
