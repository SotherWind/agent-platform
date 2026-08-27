import type Database from "better-sqlite3";
import type { DataSourceConfig, SqlExecutor } from "./types.js";
import { createExecutor } from "./executors/index.js";
import {
  createMysqlPoolClient,
  type MysqlQueryClient,
} from "./executors/mysql.js";
import {
  createPostgresPoolClient,
  type PostgresQueryClient,
} from "./executors/postgresql.js";
import {
  createExecutorRegistry,
  ExecutorRegistry,
} from "./executor-registry.js";
import type { DataSourceRegistry } from "./registry.js";
import { InMemoryDataSourceRegistry } from "./registry.js";
import type { SecretProvider } from "./secrets.js";

export interface BuildSqliteExecutorRegistryInput {
  db: Database.Database;
  dataSourceId: string;
  config?: DataSourceConfig;
}

export function buildSqliteExecutorRegistry(
  input: BuildSqliteExecutorRegistryInput,
): ExecutorRegistry {
  const executor = createExecutor({
    db: input.db,
    config: input.config,
  });
  return createExecutorRegistry(
    [{ id: input.dataSourceId, executor }],
    executor,
  );
}

/** Legacy environment shape retained for scripts that only inspect config. */
export interface LiveExecutorEnv {
  BI_ATTACH_LIVE_DATASOURCES?: string;
}

export interface AttachLiveExecutorsResult {
  registry: ExecutorRegistry;
  attached: string[];
  dataSourceConfigs: DataSourceConfig[];
  clients: Array<MysqlQueryClient | PostgresQueryClient>;
}

export interface AttachLiveExecutorsOptions {
  dataSourceRegistry: DataSourceRegistry;
  secretProvider: SecretProvider;
  environment: string;
  poolMax?: number;
  tenantConcurrencyMax?: number;
}

/** Build live executors exclusively from the operator-managed datasource registry. */
export async function attachLiveExecutors(
  registry: ExecutorRegistry,
  options: AttachLiveExecutorsOptions,
): Promise<AttachLiveExecutorsResult> {
  const attached: string[] = [];
  const dataSourceConfigs: DataSourceConfig[] = [];
  const clients: Array<MysqlQueryClient | PostgresQueryClient> = [];
  const failures: string[] = [];
  const candidates = options.dataSourceRegistry.list().filter(
    (source) =>
      source.dialectFamily === "mysql" || source.dialectFamily === "postgresql",
  );

  for (const config of candidates) {
    let client: MysqlQueryClient | PostgresQueryClient | undefined;
    try {
      const connection = config.connection;
      if (!connection.host || !connection.database || !connection.user) {
        throw new Error("Registry connection requires host, database and user");
      }
      if (!connection.secretRef) {
        throw new Error("Registry connection requires secretRef");
      }
      const resolved = await options.secretProvider.resolve(connection.secretRef);
      if (!resolved.value) throw new Error("resolved database secret is empty");
      const deployed =
        options.environment === "staging" || options.environment === "production";
      if (deployed && connection.ssl !== true) {
        throw new Error("TLS with certificate verification is required for deployed datasources");
      }

      if (config.dialectFamily === "mysql") {
        client = await createMysqlPoolClient({
          host: connection.host,
          port: connection.port ?? 3306,
          user: connection.user,
          password: resolved.value,
          database: connection.database,
          ssl: connection.ssl,
          rejectUnauthorized: connection.rejectUnauthorized,
          ca: connection.ca,
          cert: connection.cert,
          key: connection.key,
          requireVerifiedTls: deployed,
          readOnly: true,
          connectionLimit: options.poolMax,
        });
        await client.ping();
        registry.register(
          config.id,
          createExecutor({
            config,
            mysqlClient: client,
            environment: options.environment,
            tenantConcurrencyMax: options.tenantConcurrencyMax,
          }),
        );
      } else {
        client = await createPostgresPoolClient({
          host: connection.host,
          port: connection.port ?? 5432,
          user: connection.user,
          password: resolved.value,
          database: connection.database,
          ssl: connection.ssl,
          rejectUnauthorized: connection.rejectUnauthorized,
          ca: connection.ca,
          cert: connection.cert,
          key: connection.key,
          requireVerifiedTls: deployed,
          readOnly: true,
          max: options.poolMax,
        });
        await client.ping();
        registry.register(
          config.id,
          createExecutor({
            config,
            postgresClient: client,
            environment: options.environment,
            tenantConcurrencyMax: options.tenantConcurrencyMax,
          }),
        );
      }
      clients.push(client);
      attached.push(config.id);
      dataSourceConfigs.push(config);
    } catch (error) {
      await client?.end().catch(() => {});
      failures.push(
        `${config.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    await Promise.allSettled(clients.map((candidate) => candidate.end()));
    throw new Error(`Live datasource startup failed: ${failures.join("; ")}`);
  }

  return { registry, attached, dataSourceConfigs, clients };
}

export function mergeDataSourceConfigs(
  base: DataSourceRegistry,
  extras: DataSourceConfig[],
): DataSourceRegistry {
  if (extras.length === 0) return base;
  const byId = new Map(base.list().map((config) => [config.id, config]));
  for (const config of extras) byId.set(config.id, config);
  return InMemoryDataSourceRegistry.fromConfigs([...byId.values()]);
}

export type { SqlExecutor };
