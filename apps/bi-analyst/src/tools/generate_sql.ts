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

export const generateSqlTool = tool(
  async ({ query, schema, dialect }) => {
    const dialectLabel = dialect ?? "sqlite";
    const prompt = `你是一个 SQL 专家。根据以下数据库结构和用户需求，生成合法的 SQL 语句。
      数据库结构：\n${JSON.stringify(schema, null, 2)}
      用户需求：${query}
      要求：
      1. 只生成 SELECT 语句，不允许 INSERT / UPDATE / DELETE / DROP
      2. 使用 ${dialectLabel} 方言语法
      3. 字段名和表名必须与 Schema 中完全一致`;

    const result = await getLLM()
      .withStructuredOutput(SqlOutputSchema)
      .invoke(prompt);
    return result.sql;
  },
  {
    name: "generate_sql",
    description: "将自然语言转换为 SQL 查询语句",
    schema: GenerateSqlInput,
  },
);
