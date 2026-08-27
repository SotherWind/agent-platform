import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createMysqlPoolClient,
  MysqlExecutor,
} from "../../../src/datasource/executors/mysql.js";
import {
  createPostgresPoolClient,
  PostgresExecutor,
} from "../../../src/datasource/executors/postgresql.js";
import {
  dockerMysqlConnectionFromEnv,
  dockerMariadbConnectionFromEnv,
  dockerPostgresConnectionFromEnv,
} from "../../../src/metadata/live-scanner.js";
import { test, section, addSkipped } from "../../helpers/runner.js";
import { attachLiveExecutors } from "../../../src/datasource/executor-factory.js";
import { ExecutorRegistry } from "../../../src/datasource/executor-registry.js";
import { InMemoryDataSourceRegistry } from "../../../src/datasource/registry.js";
import { TestSecretProvider } from "../../../src/datasource/secrets.js";
import { resolveCapabilities } from "../../../src/datasource/capabilities.js";

async function canConnectMysql(): Promise<boolean> {
  try {
    const conn = dockerMysqlConnectionFromEnv();
    const client = await createMysqlPoolClient({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionLimit: 1,
    });
    await client.ping();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function canConnectMariadb(): Promise<boolean> {
  try {
    const conn = dockerMariadbConnectionFromEnv();
    const client = await createMysqlPoolClient({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionLimit: 1,
    });
    await client.ping();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function canConnectPostgres(): Promise<boolean> {
  try {
    const conn = dockerPostgresConnectionFromEnv();
    const client = await createPostgresPoolClient({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      max: 1,
    });
    await client.ping();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

function baseRequest(
  dataSourceId: string,
  sql: string,
  timeoutMs = 5_000,
) {
  return {
    sql,
    dataSourceId,
    tenantId: "tenant-live",
    subjectId: "user-live",
    requestId: `live-${crypto.randomUUID()}`,
    timeoutMs,
  };
}

export async function testLiveDbExecutor() {
  section("Live MySQL/MariaDB/PG Executor Certification");

  const mysqlOk = await canConnectMysql();
  const mariadbOk = await canConnectMariadb();
  const pgOk = await canConnectPostgres();

  if (!mysqlOk && !mariadbOk && !pgOk) {
    console.log(
      "  ⊘ 跳过：未检测到 MySQL/MariaDB/PG（先 pnpm docker:up）",
    );
    addSkipped(18);
    return;
  }

  if (mysqlOk && pgOk) {
    await test("Registry + SecretProvider attach live executors", async () => {
      const mysql = dockerMysqlConnectionFromEnv();
      const postgres = dockerPostgresConnectionFromEnv();
      const [mysqlCa, postgresCa] = await Promise.all([
        readFile(resolve(process.cwd(), "docker/mysql/certs/ca.pem"), "utf8"),
        readFile(
          resolve(process.cwd(), "docker/postgres/certs/ca.pem"),
          "utf8",
        ),
      ]);
      const dataSourceRegistry = InMemoryDataSourceRegistry.fromConfigs([
        {
          id: "registry_mysql",
          label: "Registry MySQL",
          domain: "retail",
          productType: "MySQL",
          dialectFamily: "mysql",
          supportStatus: "experimental",
          connection: {
            host: mysql.host,
            port: mysql.port,
            user: mysql.user,
            database: mysql.database,
            ssl: true,
            rejectUnauthorized: true,
            ca: mysqlCa,
            secretRef: { provider: "test", key: "MYSQL_PASSWORD" },
          },
          exposedSchemas: [mysql.database],
          capabilities: resolveCapabilities("mysql"),
        },
        {
          id: "registry_postgres",
          label: "Registry PostgreSQL",
          domain: "retail",
          productType: "PostgreSQL",
          dialectFamily: "postgresql",
          supportStatus: "experimental",
          connection: {
            host: postgres.host,
            port: postgres.port,
            user: postgres.user,
            database: postgres.database,
            ssl: true,
            rejectUnauthorized: true,
            ca: postgresCa,
            secretRef: { provider: "test", key: "PG_PASSWORD" },
          },
          exposedSchemas: [postgres.schema ?? "public"],
          capabilities: resolveCapabilities("postgresql"),
        },
      ]);
      const executors = new ExecutorRegistry();
      await attachLiveExecutors(executors, {
        dataSourceRegistry,
        secretProvider: new TestSecretProvider({
          MYSQL_PASSWORD: mysql.password,
          PG_PASSWORD: postgres.password,
        }),
        environment: "staging",
      });
      try {
        assert.deepEqual(executors.listIds().sort(), [
          "registry_mysql",
          "registry_postgres",
        ]);
        const health = await executors.healthCheckAll();
        assert.equal(health.registry_mysql?.healthy, true);
        assert.equal(health.registry_postgres?.healthy, true);
      } finally {
        await executors.closeAll();
      }
    });
  } else {
    addSkipped(1);
  }

  if (mysqlOk) {
    const conn = dockerMysqlConnectionFromEnv();
    const client = await createMysqlPoolClient({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionLimit: 2,
    });
    const executor = new MysqlExecutor({
      dataSourceId: "sales_mysql",
      client,
      allowedTables: ["users", "orders"],
    });

    try {
      await test("MySQL live: healthCheck", async () => {
        const health = await executor.healthCheck();
        assert.equal(health.healthy, true);
      });

      await test("MySQL live: SELECT 返回订单行", async () => {
        const result = await executor.execute(
          baseRequest(
            "sales_mysql",
            "SELECT id, amount, status FROM orders WHERE status = 'paid'",
          ),
          new AbortController().signal,
        );
        assert.equal(result.error, undefined);
        assert.equal(result.isEmpty, false);
        assert.ok((result.rows?.length ?? 0) >= 1);
        assert.ok(result.columns?.includes("amount"));
      });

      await test("MySQL live: 拒绝 DML（只读）", async () => {
        const result = await executor.execute(
          baseRequest(
            "sales_mysql",
            "DELETE FROM orders WHERE id = 1",
          ),
          new AbortController().signal,
        );
        assert.equal(result.failureKind, "policy_rejected");
      });

      await test("MySQL live: rowFilters 仅返回北京用户", async () => {
        const result = await executor.execute(
          {
            ...baseRequest("sales_mysql", "SELECT city FROM users"),
            rowFilters: [
              {
                table: "users",
                column: "city",
                operator: "=",
                values: ["北京"],
              },
            ],
          },
          new AbortController().signal,
        );
        assert.equal(result.error, undefined);
        assert.ok((result.rows?.length ?? 0) >= 1);
        assert.ok(result.rows!.every((r) => r.city === "北京"));
      });

      await test("MySQL live: 短超时触发 timeout", async () => {
        const slowClient = {
          async query(sql: string, params?: (string | number)[]) {
            await new Promise((r) => setTimeout(r, 800));
            return client.query(sql, params);
          },
          ping: () => client.ping(),
          end: async () => {},
        };
        const slowExec = new MysqlExecutor({
          dataSourceId: "sales_mysql",
          client: slowClient,
          allowedTables: ["users", "orders"],
        });
        const result = await slowExec.execute(
          baseRequest(
            "sales_mysql",
            "SELECT id FROM orders LIMIT 1",
            100,
          ),
          new AbortController().signal,
        );
        assert.equal(result.failureKind, "timeout");
      });

      await test("MySQL live: TLS + CA 校验证书连接", async () => {
        const { readFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        const caPath = resolve(
          process.cwd(),
          "docker/mysql/certs/ca.pem",
        );
        const ca = await readFile(caPath, "utf8");
        const tlsClient = await createMysqlPoolClient({
          host: conn.host,
          port: conn.port,
          user: conn.user,
          password: conn.password,
          database: conn.database,
          ssl: true,
          rejectUnauthorized: true,
          ca,
          connectionLimit: 1,
        });
        try {
          await tlsClient.ping();
          const { rows } = await tlsClient.query("SELECT 1 AS ok");
          assert.ok((rows?.length ?? 0) >= 1);
          assert.equal(Number(rows[0]?.ok), 1);
        } finally {
          await tlsClient.end();
        }
      });

      await test("MySQL live: mTLS 客户端证书连接", async () => {
        const { readFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        const certDir = resolve(process.cwd(), "docker/mysql/certs");
        const [ca, cert, key] = await Promise.all([
          readFile(resolve(certDir, "ca.pem"), "utf8"),
          readFile(resolve(certDir, "client-cert.pem"), "utf8"),
          readFile(resolve(certDir, "client-key.pem"), "utf8"),
        ]);
        const mtlsClient = await createMysqlPoolClient({
          host: conn.host,
          port: conn.port,
          user: "bi_mtls",
          password: "bi_mtls_dev",
          database: conn.database,
          ssl: true,
          rejectUnauthorized: true,
          ca,
          cert,
          key,
          connectionLimit: 1,
        });
        try {
          await mtlsClient.ping();
          const { rows } = await mtlsClient.query(
            "SELECT COUNT(*) AS cnt FROM users",
          );
          assert.ok(Number(rows[0]?.cnt) >= 1);
        } finally {
          await mtlsClient.end();
        }
      });
    } finally {
      await executor.close();
    }
  } else {
    console.log("  ⊘ 跳过 MySQL live executor");
    addSkipped(7);
  }

  if (mariadbOk) {
    const conn = dockerMariadbConnectionFromEnv();
    const client = await createMysqlPoolClient({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionLimit: 2,
    });
    const executor = new MysqlExecutor({
      dataSourceId: "sales_mariadb",
      client,
      allowedTables: ["users", "orders"],
    });

    try {
      await test("MariaDB live: healthCheck", async () => {
        const health = await executor.healthCheck();
        assert.equal(health.healthy, true);
      });

      await test("MariaDB live: SELECT 返回订单行", async () => {
        const result = await executor.execute(
          baseRequest(
            "sales_mariadb",
            "SELECT id, amount, status FROM orders WHERE status = 'paid'",
          ),
          new AbortController().signal,
        );
        assert.equal(result.error, undefined);
        assert.equal(result.isEmpty, false);
        assert.ok((result.rows?.length ?? 0) >= 1);
      });

      await test("MariaDB live: 拒绝 DML", async () => {
        const result = await executor.execute(
          baseRequest(
            "sales_mariadb",
            "DELETE FROM orders WHERE id = 1",
          ),
          new AbortController().signal,
        );
        assert.equal(result.failureKind, "policy_rejected");
      });

      await test("MariaDB live: rowFilters 仅返回北京用户", async () => {
        const result = await executor.execute(
          {
            ...baseRequest("sales_mariadb", "SELECT city FROM users"),
            rowFilters: [
              {
                table: "users",
                column: "city",
                operator: "=",
                values: ["北京"],
              },
            ],
          },
          new AbortController().signal,
        );
        assert.equal(result.error, undefined);
        assert.ok((result.rows?.length ?? 0) >= 1);
        assert.ok(result.rows!.every((r) => r.city === "北京"));
      });
    } finally {
      await executor.close();
    }
  } else {
    console.log("  ⊘ 跳过 MariaDB live executor（端口 3307）");
    addSkipped(4);
  }

  if (pgOk) {
    const conn = dockerPostgresConnectionFromEnv();
    const client = await createPostgresPoolClient({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      max: 2,
    });
    const executor = new PostgresExecutor({
      dataSourceId: "analytics_pg",
      client,
      allowedTables: ["users", "orders"],
    });

    try {
      await test("PostgreSQL live: healthCheck", async () => {
        const health = await executor.healthCheck();
        assert.equal(health.healthy, true);
      });

      await test("PostgreSQL live: SELECT 聚合城市用户", async () => {
        const result = await executor.execute(
          baseRequest(
            "analytics_pg",
            "SELECT city, COUNT(*)::int AS cnt FROM users GROUP BY city",
          ),
          new AbortController().signal,
        );
        assert.equal(result.error, undefined);
        assert.equal(result.isEmpty, false);
        assert.ok((result.rows?.length ?? 0) >= 1);
        assert.ok(result.columns?.includes("city"));
      });

      await test("PostgreSQL live: 拒绝 DML（只读）", async () => {
        const result = await executor.execute(
          baseRequest(
            "analytics_pg",
            "UPDATE users SET city = 'x' WHERE id = 1",
          ),
          new AbortController().signal,
        );
        assert.equal(result.failureKind, "policy_rejected");
      });

      await test("PostgreSQL live: rowFilters 仅返回北京用户", async () => {
        const result = await executor.execute(
          {
            ...baseRequest("analytics_pg", "SELECT city FROM users"),
            rowFilters: [
              {
                table: "users",
                column: "city",
                operator: "=",
                values: ["北京"],
              },
            ],
          },
          new AbortController().signal,
        );
        assert.equal(result.error, undefined);
        assert.ok((result.rows?.length ?? 0) >= 1);
        assert.ok(result.rows!.every((r) => r.city === "北京"));
      });

      await test("PostgreSQL live: 短超时触发 timeout", async () => {
        const slowClient = {
          async query(sql: string, params?: (string | number)[]) {
            await new Promise((r) => setTimeout(r, 800));
            return client.query(sql, params);
          },
          ping: () => client.ping(),
          end: async () => {},
        };
        const slowExec = new PostgresExecutor({
          dataSourceId: "analytics_pg",
          client: slowClient,
          allowedTables: ["users", "orders"],
        });
        const result = await slowExec.execute(
          baseRequest(
            "analytics_pg",
            "SELECT id FROM orders WHERE id > 0 LIMIT 1",
            100,
          ),
          new AbortController().signal,
        );
        assert.equal(result.failureKind, "timeout");
      });

      await test("PostgreSQL live: TLS + CA 校验证书连接", async () => {
        const { readFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        const ca = await readFile(
          resolve(process.cwd(), "docker/postgres/certs/ca.pem"),
          "utf8",
        );
        const tlsClient = await createPostgresPoolClient({
          host: conn.host,
          port: conn.port,
          user: conn.user,
          password: conn.password,
          database: conn.database,
          ssl: true,
          rejectUnauthorized: true,
          ca,
          max: 1,
        });
        try {
          await tlsClient.ping();
          const { rows } = await tlsClient.query("SELECT 1 AS ok");
          assert.equal(Number(rows[0]?.ok), 1);
        } finally {
          await tlsClient.end();
        }
      });
    } finally {
      await executor.close();
    }
  } else {
    console.log("  ⊘ 跳过 PostgreSQL live executor");
    addSkipped(6);
  }
}
