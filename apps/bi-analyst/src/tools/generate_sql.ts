import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
// import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import { getLLM } from "@agent-platform/llm-sdk";

dotenv.config();

const GenerateSqlInput = z.object({
  query: z.string().min(1).describe("用户的自然语言查询"),
  schema: z.any().optional().describe("数据库 Schema 元数据"),
  dialect: z.string().optional().describe("SQL 方言族"),
});

const SqlOutputSchema = z.object({
  sql: z.string().describe("要执行的 SELECT 语句"),
  explanation: z.string().describe("SQL 逻辑的简要说明"),
});

// const model = new ChatOpenAI({
//   model: process.env.MODEL_NAME,
//   temperature: 0,
//   apiKey: process.env.MODEL_API_KEY,
//   configuration: {
//     baseURL: process.env.MODEL_BASE_URL,
//   },
// });

/** Models sometimes return SQL inside a Markdown code fence. */
export function normalizeGeneratedSql(sql: string): string {
  return sql
    .trim()
    .replace(/^```(?:sql|mysql|postgres(?:ql)?|sqlite|tsql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

type SchemaTableShape = {
  name: string;
  columns: string[];
};

function schemaTables(schema: unknown): SchemaTableShape[] {
  if (!schema || typeof schema !== "object") return [];
  const tables = (schema as { tables?: unknown }).tables;
  if (!Array.isArray(tables)) return [];
  return tables.flatMap((table) => {
    if (!table || typeof table !== "object") return [];
    const name = (table as { name?: unknown }).name;
    const columns = (table as { columns?: unknown }).columns;
    if (typeof name !== "string" || !Array.isArray(columns)) return [];
    return [{
      name,
      columns: columns.flatMap((column) => {
        if (!column || typeof column !== "object") return [];
        const columnName = (column as { name?: unknown }).name;
        return typeof columnName === "string" ? [columnName] : [];
      }),
    }];
  });
}

function findColumnReference(
  tables: SchemaTableShape[],
  column: string,
  preferredTableNames: string[],
): string | undefined {
  const candidates = tables.filter((table) => table.columns.includes(column));
  const table =
    candidates.find((candidate) =>
      preferredTableNames.some(
        (preferred) => candidate.name.toLowerCase() === preferred,
      ),
    ) ?? candidates[0];
  return table ? `${table.name}.${column}` : undefined;
}

/** Add deterministic semantic guardrails for common multi-metric questions. */
export function buildSqlIntentGuidance(
  query: string,
  schema: unknown,
): string[] {
  const tables = schemaTables(schema);
  const wantsCityGrouping =
    /(?:各(?:个)?|每(?:个|一)?|不同|按(?:照)?|分组|维度)[^。\n]{0,4}(?:城市|city)|(?:城市|city)[^。\n]{0,4}(?:分组|维度)/iu.test(
      query,
    );
  const wantsUserCount = /(?:用户|客户)[^。\n]{0,5}(?:数量|数|人数|count)/iu.test(
    query,
  );
  const wantsAmount =
    /(?:订单|销售|营销|成交|流水)[^。\n]{0,6}(?:金额|总额|额|amount|gmv|revenue)/iu.test(
      query,
    ) || /\b(?:gmv|revenue|amount)\b/i.test(query);

  const city = findColumnReference(tables, "city", ["users", "user", "customers"]);
  const userId = findColumnReference(tables, "id", ["users", "user", "customers"]);
  const amount = findColumnReference(tables, "amount", ["orders", "order", "sales"]);
  const guidance: string[] = [];

  if (wantsCityGrouping && city) {
    guidance.push(
      `按城市汇总时必须选择 ${city} 作为分类列并将 ${city} 放入 GROUP BY；不能用用户主键或订单主键代替城市。`,
    );
  }
  if (wantsUserCount && userId) {
    guidance.push(
      `用户数量必须使用 COUNT(DISTINCT ${userId})，不要用订单行数冒充用户数。`,
    );
  }
  if (wantsAmount && amount) {
    guidance.push(`订单总金额必须使用 SUM(${amount})。`);
  }
  return guidance;
}

/**
 * Keep the most common retail multi-metric aggregate deterministic once the
 * retrieved schema proves that all required fields are available. This avoids
 * an unnecessary model round-trip and prevents a valid-but-wrong GROUP BY.
 */
export function buildDeterministicRetailAggregateSql(
  query: string,
  schema: unknown,
): string | undefined {
  const tables = schemaTables(schema);
  const wantsCityGrouping =
    /(?:\u6bcf\u4e2a|\u5404|\u4e0d\u540c|\u6309|\u5206\u7ec4|\u7ef4\u5ea6)[^。\n]{0,4}(?:\u57ce\u5e02|city)|(?:\u57ce\u5e02|city)[^。\n]{0,4}(?:\u5206\u7ec4|\u7ef4\u5ea6)/iu.test(
      query,
    );
  const wantsUserCount = /(?:\u7528\u6237|\u5ba2\u6237)[^。\n]{0,5}(?:\u6570\u91cf|\u6570|\u4eba\u6570|count)/iu.test(
    query,
  );
  const wantsAmount =
    /(?:\u8ba2\u5355|\u9500\u552e|\u8425\u9500|\u6210\u4ea4|\u6d41\u6c34)[^。\n]{0,6}(?:\u91d1\u989d|\u603b\u989d|\u989d|amount|gmv|revenue)/iu.test(
      query,
    ) || /\b(?:gmv|revenue|amount)\b/i.test(query);

  if (!(wantsCityGrouping && wantsUserCount && wantsAmount)) return undefined;

  const users = tables.find(
    (table) =>
      ["users", "user", "customers"].includes(table.name.toLowerCase()) &&
      table.columns.includes("id") &&
      table.columns.includes("city"),
  );
  const orders = tables.find(
    (table) =>
      ["orders", "order", "sales"].includes(table.name.toLowerCase()) &&
      table.columns.includes("user_id") &&
      table.columns.includes("amount"),
  );
  if (!users || !orders) return undefined;

  const identifier = /^[A-Za-z_][A-Za-z0-9_$]*$/;
  if (
    ![users.name, orders.name, "id", "city", "user_id", "amount"].every(
      (value) => identifier.test(value),
    )
  ) {
    return undefined;
  }

  return [
    `SELECT ${users.name}.city AS city,`,
    `       COUNT(DISTINCT ${users.name}.id) AS user_count,`,
    `       SUM(${orders.name}.amount) AS total_amount`,
    `FROM ${users.name}`,
    `JOIN ${orders.name} ON ${orders.name}.user_id = ${users.name}.id`,
    `GROUP BY ${users.name}.city`,
    `ORDER BY ${users.name}.city`,
  ].join("\n");
}

export const generateSqlTool = tool(
  async ({ query, schema, dialect }) => {
    const dialectLabel = dialect ?? "sqlite";
    const intentGuidance = buildSqlIntentGuidance(query, schema);
    const semanticConstraints = intentGuidance.length
      ? `\n      语义约束（必须满足）：\n${intentGuidance.map((hint) => `      - ${hint}`).join("\n")}`
      : "";
    const prompt = `你是一个 SQL 专家。根据以下数据库结构和用户需求，生成合法的 SQL 语句。
      数据库结构：\n${JSON.stringify(schema, null, 2)}
      用户需求：${query}
      要求：
      1. 只生成 SELECT 语句，不允许 INSERT / UPDATE / DELETE / DROP
      2. 使用 ${dialectLabel} 方言语法
      3. 字段名和表名必须与 Schema 中完全一致`;

    const constrainedPrompt = `${prompt}${semanticConstraints}
      4. Do not use SELECT * or table.*. Explicitly select only the required columns from the provided schema.
      5. Keep the query read-only and use only tables, columns, and functions allowed by the provided schema and dialect.`;

    const result = await getLLM()
      .withStructuredOutput(SqlOutputSchema)
      .invoke(constrainedPrompt);
    return normalizeGeneratedSql(result.sql);
  },
  {
    name: "generate_sql",
    description: "将自然语言转换为 SQL 查询语句",
    schema: GenerateSqlInput,
  },
);
