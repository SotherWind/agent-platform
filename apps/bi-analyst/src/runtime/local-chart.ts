import type { ExecutionResult } from "../entities.js";
import type { ChartType } from "../entities.js";

export interface LocalChartSuggestion {
  chartType: ChartType;
  title: string;
  explanation: string;
}

/** 无 LLM 时的确定性图表推荐 + 结果摘要（本地开发默认路径） */
export function suggestChartConfigLocal(
  query: string,
  data: ExecutionResult,
): LocalChartSuggestion {
  const cols = data.columns ?? [];
  const rows = data.rows ?? [];
  const numericCols = cols.filter((c) =>
    rows.some((r) => isNumericValue(r[c])),
  );
  const categoryCols = cols.filter((c) => !numericCols.includes(c));

  let chartType: ChartType = "table";
  if (categoryCols.length >= 1 && numericCols.length >= 1 && rows.length <= 30) {
    if (/占比|比例|构成/.test(query)) {
      chartType = "pie";
    } else if (
      /趋势|时间|每天|每日|每周|每月|每季度|逐年|按[天日周月年季]|trend|over\s+time|quarter/i.test(
        query,
      )
    ) {
      chartType = "line";
    } else {
      chartType = "bar";
    }
  } else if (numericCols.length >= 2) {
    chartType = "scatter";
  } else if (
    /趋势|时间|每天|每日|每周|每月|每季度|逐年|按[天日周月年季]|trend|over\s+time|quarter/i.test(
      query,
    ) &&
    numericCols.length >= 1
  ) {
    chartType = "line";
  }

  const title = deriveTitle(query, categoryCols[0], numericCols[0]);
  const explanation = summarizeRows(query, cols, rows, numericCols[0]);

  return { chartType, title, explanation };
}

function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

function deriveTitle(
  query: string,
  category?: string,
  measure?: string,
): string {
  if (query.trim().length > 0 && query.trim().length <= 40) {
    return query.trim();
  }
  if (category && measure) return `${category} × ${measure}`;
  return "分析结果";
}

function summarizeRows(
  query: string,
  columns: string[],
  rows: Record<string, unknown>[],
  measure?: string,
): string {
  if (rows.length === 0) {
    return `针对「${query}」未查到数据。`;
  }

  const lines: string[] = [`针对「${query}」共返回 ${rows.length} 行结果。`];

  if (measure && rows.length === 1) {
    const row = rows[0]!;
    const parts = columns.map((c) => `${c}=${formatValue(row[c])}`);
    lines.push(parts.join("，") + "。");
    return lines.join("");
  }

  if (measure && rows.length <= 10) {
    for (const row of rows) {
      const label = columns
        .filter((c) => c !== measure)
        .map((c) => String(row[c] ?? ""))
        .filter(Boolean)
        .join("/");
      lines.push(`- ${label || "合计"}：${formatValue(row[measure])}`);
    }
    return lines.join("\n");
  }

  const preview = rows.slice(0, 5).map((row) =>
    columns.map((c) => `${c}=${formatValue(row[c])}`).join(", "),
  );
  lines.push("前几行：");
  lines.push(...preview.map((p) => `- ${p}`));
  if (rows.length > 5) lines.push(`…共 ${rows.length} 行`);
  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value)
      : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
  return String(value);
}

export function hasConfiguredLlm(): boolean {
  if (
    process.env.APP_ENV === "test" &&
    process.env.ENABLE_LIVE_LLM_EVAL !== "1"
  ) {
    return false;
  }
  return Boolean(
    process.env.MODEL_API_KEY?.trim() ||
      process.env.LLM_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim(),
  );
}
