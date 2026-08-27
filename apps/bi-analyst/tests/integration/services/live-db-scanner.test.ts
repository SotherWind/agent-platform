import assert from "node:assert/strict";
import {
  dockerMysqlConnectionFromEnv,
  dockerPostgresConnectionFromEnv,
  scanMysqlSchemaLive,
  scanPostgresSchemaLive,
} from "../../../src/metadata/live-scanner.js";
import { test, section, addSkipped } from "../../helpers/runner.js";

async function canConnectMysql(): Promise<boolean> {
  try {
    const mysql = await import("mysql2/promise");
    const conn = dockerMysqlConnectionFromEnv();
    const pool = mysql.createPool({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectTimeout: 2000,
    });
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

async function canConnectPostgres(): Promise<boolean> {
  try {
    const pg = await import("pg");
    const conn = dockerPostgresConnectionFromEnv();
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export async function testLiveDbScanner() {
  section("Live MySQL/PG Schema Scanner");

  const mysqlOk = await canConnectMysql();
  const pgOk = await canConnectPostgres();

  if (!mysqlOk && !pgOk) {
    console.log(
      "  ⊘ 跳过：未检测到 MySQL/PG（先 docker compose -f docker/docker-compose.yml up -d）",
    );
    addSkipped(2);
    return;
  }

  if (mysqlOk) {
    await test("scanMysqlSchemaLive 连库扫描 retail.users/orders", async () => {
      const docs = await scanMysqlSchemaLive(dockerMysqlConnectionFromEnv(), {
        datasourceId: "sales_mysql",
        domain: "retail",
        tables: ["users", "orders"],
      });
      assert.ok(docs.some((d) => d.docType === "datasource"));
      assert.ok(docs.some((d) => d.table === "users"));
      assert.ok(docs.some((d) => d.table === "orders" && d.column === "amount"));
      assert.ok(docs.every((d) => d.dialectFamily === "mysql"));
    });
  } else {
    console.log("  ⊘ 跳过 MySQL live scanner");
    addSkipped(1);
  }

  if (pgOk) {
    await test(
      "scanPostgresSchemaLive 连库扫描 public.users/orders",
      async () => {
        const docs = await scanPostgresSchemaLive(
          dockerPostgresConnectionFromEnv(),
          {
            datasourceId: "analytics_pg",
            domain: "retail",
            tables: ["users", "orders"],
          },
        );
        assert.ok(docs.some((d) => d.docType === "datasource"));
        assert.ok(docs.some((d) => d.table === "users" && d.column === "city"));
        assert.ok(docs.some((d) => d.table === "orders"));
        assert.ok(docs.every((d) => d.dialectFamily === "postgresql"));
      },
    );
  } else {
    console.log("  ⊘ 跳过 PostgreSQL live scanner");
    addSkipped(1);
  }
}
