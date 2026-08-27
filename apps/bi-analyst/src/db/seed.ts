// Demo data fixture for development and tests only.
import type Database from "better-sqlite3";
import path from "node:path";
import { openSqliteDatabase } from "./sqlite.js";

export { getSchema } from "./sqlite.js";

const DB_PATH = path.resolve(import.meta.dirname, "../../data/ecommerce.db");

export function createDatabase(dbPath = DB_PATH): Database.Database {
  const db = openSqliteDatabase(dbPath, { createParent: true });
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

const SEED_USERS = [
  ["Alice", "北京"],
  ["Bob", "上海"],
  ["Charlie", "北京"],
  ["Diana", "深圳"],
  ["Eve", "杭州"],
  ["Frank", "北京"],
  ["Grace", "成都"],
  ["Hank", "武汉"],
  ["Isabel", "南京"],
  ["Jack", "西安"],
  ["Kate", "上海"],
  ["Linda", "北京"],
] as const;

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

export function seedDatabase(db: Database.Database): void {
  db.exec("DELETE FROM orders; DELETE FROM users;");

  db.transaction(() => {
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
  })();
}
