import assert from "node:assert/strict";
import { seedDatabase, getSchema } from "../../src/db/seed";
import { test, section } from "../helpers/runner";
import { createTestDb, cleanupDb } from "../helpers/db";

export async function testDatabase() {
  section("数据库层 (createDatabase / seedDatabase / getSchema)");

  const { db, dbPath } = createTestDb();
  try {
    await test("种子数据：users 表应有 12 条记录", () => {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
      assert.equal(count, 12);
    });

    await test("种子数据：orders 表应有 10 条记录", () => {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
      assert.equal(count, 10);
    });

    await test("种子数据：北京用户共 4 人", () => {
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM users WHERE city = ?").get("北京") as { n: number }
      ).n;
      assert.equal(count, 4);
    });

    await test("seedDatabase 幂等：重复执行后记录数不变", () => {
      seedDatabase(db);
      const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
      const orders = (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
      assert.equal(users, 12);
      assert.equal(orders, 10);
    });

    await test("getSchema 返回 users / orders 两张表", () => {
      const schema = getSchema(db);
      const tableNames = schema.tables.map((t) => t.name).sort();
      assert.deepEqual(tableNames, ["orders", "users"]);
    });

    await test("getSchema：orders.user_id 带有外键描述", () => {
      const schema = getSchema(db);
      const orders = schema.tables.find((t) => t.name === "orders");
      assert.ok(orders);
      const userIdCol = orders.columns.find((c) => c.name === "user_id");
      assert.equal(userIdCol?.description, "关联 users.id 的外键");
    });

    await test("getSchema：users 表包含 id / name / city 列", () => {
      const schema = getSchema(db);
      const users = schema.tables.find((t) => t.name === "users");
      assert.ok(users);
      const colNames = users.columns.map((c) => c.name);
      assert.ok(colNames.includes("id"));
      assert.ok(colNames.includes("name"));
      assert.ok(colNames.includes("city"));
    });
  } finally {
    db.close();
    cleanupDb(dbPath);
  }
}
