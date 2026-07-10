// src/db/seed.ts
//
// ⚠️ 仅用于 demo / 单元测试 / 集成测试 fixture。
// 企业级运行时不得调用 createDatabase / seedDatabase / getSchema（全量 schema）；
// 生产链路应使用 DataSourceRegistry + Schema RAG（见 docs/ENTERPRISE-PLAN.md）。
//
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve(import.meta.dirname, "../../data/ecommerce.db");

export function createDatabase(dbPath = DB_PATH): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      city       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id),
      amount     REAL NOT NULL,
      status     TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

/** users 表种子数据：[name, city] */
const SEED_USERS = [
  ["Alice", "北京"],
  ["Bob", "上海"],
  ["Charlie", "北京"],
  ["Diana", "广州"],
  ["Eve", "深圳"],
  ["Frank", "北京"],
  ["Grace", "杭州"],
  ["Hank", "武汉"],
  ["Isabel", "北京"],
  ["Jack", "西安"],
  ["Kate", "上海"],
  ["Linda", "杭州"],
] as const;

/** orders 表种子数据：[userName, amount, status, created_at]；userName 仅在 seed 阶段解析为 user_id */
const SEED_ORDERS = [
  ["Alice", 299.99, "paid", "2024-01-15"],
  ["Alice", 599.0, "shipped", "2024-02-20"],
  ["Bob", 150.5, "paid", "2024-01-22"],
  ["Charlie", 1200.0, "pending", "2024-03-01"],
  ["Charlie", 89.99, "cancelled", "2024-03-10"],
  ["Diana", 450.0, "paid", "2024-02-14"],
  ["Eve", 399.99, "phone", "2024-01-18"],
  ["Grace", 299.99, "watch", "2025-04-15"],
  ["Frank", 199.99, "paid", "2025-12-08"],
  ["Hank", 150.5, "computer", "2026-04-22"],
] as const;

/** 灌入测试数据（幂等：先清空再插入） */
export function seedDatabase(db: Database.Database) {
  db.exec("DELETE FROM orders; DELETE FROM users;");

  const seed = db.transaction(() => {
    const insertUser = db.prepare(
      "INSERT INTO users (name, city) VALUES (?, ?)",
    );
    const userIds = new Map(
      SEED_USERS.map(([name, city]) => [
        name,
        Number(insertUser.run(name, city).lastInsertRowid),
      ]),
    );

    const insertOrder = db.prepare(
      "INSERT INTO orders (user_id, amount, status, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const [userName, amount, status, createdAt] of SEED_ORDERS) {
      const userId = userIds.get(userName);
      if (userId === undefined) {
        throw new Error(`Unknown seed user: ${userName}`);
      }
      insertOrder.run(userId, amount, status, createdAt);
    }
  });

  seed();
}

/** 获取数据库 Schema 元数据（供 Text-to-SQL 使用） */
export function getSchema(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];

  return {
    tables: tables.map((t) => {
      const columns = db
        .prepare(`PRAGMA table_info('${t.name}')`)
        .all() as any[];
      return {
        name: t.name,
        columns: columns.map((c) => ({
          name: c.name,
          type: c.type,
          description:
            c.name === "user_id" ? "关联 users.id 的外键" : undefined,
        })),
      };
    }),
  };
}
