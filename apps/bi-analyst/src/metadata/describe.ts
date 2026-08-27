import type { SchemaDocument } from "./types.js";

export interface DraftDescriptionInput {
  datasourceId: string;
  table?: string;
  column?: string;
  dataType?: string;
  domain?: string;
  /** 可选：用户/运营提供的业务提示，不可信数据 */
  businessHint?: string;
}

/**
 * 模板化草案描述（可替换为 LLM 调用）。
 * 强制：产出 reviewStatus=draft，永不设置 certified，不写指标口径。
 */
export function generateDraftDescription(
  input: DraftDescriptionInput,
): SchemaDocument {
  const domain = input.domain ?? "general";
  const hint = sanitizeHint(input.businessHint);

  if (input.column && input.table) {
    const content = [
      `# 字段：${input.datasourceId}.${input.table}.${input.column}`,
      "",
      "## 业务含义（草案，待审核）",
      hint ||
        `${input.table}.${input.column} 字段，类型 ${input.dataType ?? "unknown"}。`,
      "",
      "> 本描述由辅助生成，未认证，不得直接用于 production 指标编译。",
    ].join("\n");

    return {
      id: `${input.datasourceId}.${input.table}.${input.column}`,
      docType: "column",
      content,
      datasourceId: input.datasourceId,
      domain,
      dialectFamily: "sqlite",
      table: input.table,
      column: input.column,
      reviewStatus: "draft",
      tags: ["llm-assisted-draft"],
    };
  }

  if (input.table) {
    const content = [
      `# 表：${input.datasourceId}.${input.table}`,
      "",
      "## 业务含义（草案，待审核）",
      hint || `业务表 ${input.table}。`,
      "",
      "> 本描述由辅助生成，未认证。",
    ].join("\n");
    return {
      id: `${input.datasourceId}.${input.table}`,
      docType: "table",
      content,
      datasourceId: input.datasourceId,
      domain,
      dialectFamily: "sqlite",
      table: input.table,
      reviewStatus: "draft",
      tags: ["llm-assisted-draft"],
    };
  }

  throw new Error("生成草案描述至少需要 table 或 table+column");
}

/** 明确拒绝：不得把 LLM 输出直接标为 certified metric */
export function assertNoAutoCertification(doc: SchemaDocument): void {
  if (doc.docType === "metric" && doc.reviewStatus === "approved") {
    throw new Error("禁止 LLM 辅助路径自动 certification 指标");
  }
  if (doc.tags?.includes("certified")) {
    throw new Error("禁止在辅助描述中附带 certified 标签");
  }
}

function sanitizeHint(hint?: string): string {
  if (!hint) return "";
  // 截断 + 剥离疑似指令前缀，元数据视为不可信
  return hint
    .replace(/^\s*(system|ignore|instruction)\s*[:：].*$/gim, "")
    .trim()
    .slice(0, 500);
}
