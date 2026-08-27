import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateTextToSqlCases,
  type SqlGenerator,
  type TextToSqlEvalReport,
  type TextToSqlGoldenCase,
} from "./sql-accuracy.js";

const DEMO_SCHEMA = {
  tables: {
    users: {
      columns: ["id", "name", "city", "created_at"],
    },
    orders: {
      columns: ["id", "user_id", "amount", "status", "created_at"],
    },
  },
};

export function loadTextToSqlGoldenCases(
  fixturePath?: string,
): TextToSqlGoldenCase[] {
  const file =
    fixturePath ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../tests/fixtures/evaluation/text-to-sql-golden.json",
    );
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    cases: TextToSqlGoldenCase[];
  };
  return raw.cases.map((c) => ({
    ...c,
    schema: c.schema ?? DEMO_SCHEMA,
    dialect: c.dialect ?? "sqlite",
    mustNotContain: c.mustNotContain ?? [
      "insert ",
      "update ",
      "delete ",
      "drop ",
      "alter ",
    ],
  }));
}

/** 确定性 mock：用于离线单测 / CI，不调用 LLM */
export const mockDeterministicSqlGenerator: SqlGenerator = async ({
  query,
}) => {
  const q = query.toLowerCase();
  if (q.includes("average order amount by status")) {
    return `SELECT status, AVG(amount) AS average_order_amount FROM orders GROUP BY status`;
  }
  if (q.includes("paid orders by city")) {
    return `SELECT users.city, COUNT(orders.id) AS paid_order_count
FROM orders JOIN users ON orders.user_id = users.id
WHERE orders.status = 'paid' GROUP BY users.city`;
  }
  if (q.includes("sales by city")) {
    return `SELECT users.city, SUM(orders.amount) AS total_sales
FROM orders JOIN users ON orders.user_id = users.id GROUP BY users.city`;
  }
  if (q.includes("orders by city")) {
    return `SELECT users.city, COUNT(orders.id) AS order_count
FROM orders JOIN users ON orders.user_id = users.id GROUP BY users.city`;
  }
  if (q.includes("total sales amount")) {
    return `SELECT SUM(amount) AS total_sales FROM orders`;
  }
  if (q.includes("maximum order amount")) {
    return `SELECT MAX(amount) AS maximum_order_amount FROM orders`;
  }
  if (q.includes("minimum order amount")) {
    return `SELECT MIN(amount) AS minimum_order_amount FROM orders`;
  }
  if (q.includes("total user count")) {
    return `SELECT COUNT(id) AS user_count FROM users`;
  }
  if (q.includes("distinct ordering users")) {
    return `SELECT COUNT(DISTINCT user_id) AS ordering_users FROM orders`;
  }
  if (q.includes("pending order count")) {
    return `SELECT COUNT(id) AS pending_order_count FROM orders WHERE status = 'pending'`;
  }
  if (q.includes("cancelled order count")) {
    return `SELECT COUNT(id) AS cancelled_order_count FROM orders WHERE status = 'cancelled'`;
  }
  if (q.includes("shipped order count")) {
    return `SELECT COUNT(id) AS shipped_order_count FROM orders WHERE status = 'shipped'`;
  }
  if (q.includes("shanghai order amount")) {
    return `SELECT SUM(orders.amount) AS total
FROM orders JOIN users ON orders.user_id = users.id
WHERE users.city = 'Shanghai'`;
  }
  if (q.includes("monthly user signups")) {
    return `SELECT strftime('%Y-%m', created_at) AS month, COUNT(id) AS user_count
FROM users GROUP BY strftime('%Y-%m', created_at)`;
  }
  if (q.includes("orders created since 2024")) {
    return `SELECT COUNT(id) AS order_count FROM orders WHERE created_at >= '2024-01-01'`;
  }
  if (q.includes("average order amount") || q.includes("avg order amount")) {
    return `SELECT AVG(amount) AS average_order_amount FROM orders`;
  }
  if (q.includes("paid order count")) {
    return `SELECT COUNT(id) AS paid_order_count FROM orders WHERE status = 'paid'`;
  }
  if (q.includes("城市") && q.includes("用户")) {
    return `SELECT city, COUNT(*) AS user_count FROM users GROUP BY city`;
  }
  if (q.includes("北京") && (q.includes("总额") || q.includes("金额"))) {
    return `SELECT SUM(orders.amount) AS total
FROM orders
JOIN users ON orders.user_id = users.id
WHERE users.city = '北京'`;
  }
  if (q.includes("状态") && q.includes("订单")) {
    return `SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status`;
  }
  return `SELECT * FROM orders LIMIT 10`;
};

export async function runTextToSqlAccuracyEval(options?: {
  generateSql?: SqlGenerator;
  fixturePath?: string;
  minPassRate?: number;
}): Promise<{ report: TextToSqlEvalReport; ok: boolean }> {
  const cases = loadTextToSqlGoldenCases(options?.fixturePath);
  const generateSql =
    options?.generateSql ?? mockDeterministicSqlGenerator;
  const report = await evaluateTextToSqlCases(cases, generateSql);
  const minPassRate = options?.minPassRate ?? 1;
  return { report, ok: report.passRate >= minPassRate };
}

/** live：走真实 generate_sql tool（需 MODEL_API_KEY） */
export async function createLiveSqlGenerator(): Promise<SqlGenerator> {
  const { generateSqlTool } = await import("../tools/generate_sql.js");
  return async ({ query, schema, dialect }) => {
    const sql = await generateSqlTool.invoke({
      query,
      schema,
      dialect,
    });
    return String(sql);
  };
}
