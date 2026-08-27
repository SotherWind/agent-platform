import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { DataSourceConfig, DialectFamily, SupportStatus } from "./types.js";
import {
  mapProductToDialect,
  PRODUCT_SUPPORT_STATUS,
  resolveCapabilities,
} from "./capabilities.js";
import { InMemoryDataSourceRegistry } from "./registry.js";

const ConnectionSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  database: z.string().optional(),
  filePath: z.string().optional(),
  user: z.string().optional(),
  ssl: z.boolean().optional(),
  rejectUnauthorized: z.boolean().optional(),
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  caFile: z.string().optional(),
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
  caFileEnv: z.string().optional(),
  certFileEnv: z.string().optional(),
  keyFileEnv: z.string().optional(),
  mode: z.enum(["mysql", "oracle", "pg"]).optional(),
  secretRef: z
    .object({
      provider: z.enum(["vault", "aws-sm", "azure-kv", "env", "test"]),
      key: z.string(),
      version: z.string().optional(),
    })
    .optional(),
});

const DataSourceYamlSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  domain: z.string().default("general"),
  productType: z.string().min(1),
  dialectFamily: z
    .enum(["mysql", "postgresql", "oracle", "tsql", "db2", "hana", "sqlite"])
    .optional(),
  connection: ConnectionSchema,
  exposedSchemas: z.array(z.string()).default([]),
  defaultSchema: z.string().optional(),
  supportStatus: z
    .enum(["planned", "experimental", "verified", "production-certified"])
    .optional(),
  capabilities: z
    .object({
      supportsWindowFunctions: z.boolean().optional(),
      supportsLimitOffset: z.boolean().optional(),
      identifierQuote: z.enum(['"', "`", "["]).optional(),
      maxIdentifierLength: z.number().int().positive().optional(),
      paginationStyle: z.enum(["limit", "offset-fetch", "rownum"]).optional(),
    })
    .optional(),
});

const RegistryFileSchema = z.object({
  datasources: z.array(DataSourceYamlSchema).min(1),
});

export function loadDataSourceRegistryFromYaml(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): InMemoryDataSourceRegistry {
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute, "utf8");
  const doc = RegistryFileSchema.parse(parseYaml(raw));
  const baseDirectory = path.dirname(absolute);
  const configs = doc.datasources.map((entry) =>
    normalizeDataSourceYaml(entry, baseDirectory, env),
  );
  return InMemoryDataSourceRegistry.fromConfigs(configs);
}

export function normalizeDataSourceYaml(
  entry: z.infer<typeof DataSourceYamlSchema>,
  baseDirectory = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): DataSourceConfig {
  const dialectFamily: DialectFamily =
    entry.dialectFamily ?? mapProductToDialect(entry.productType);
  const supportStatus: SupportStatus =
    entry.supportStatus ??
    PRODUCT_SUPPORT_STATUS[entry.productType] ??
    "planned";

  return {
    id: entry.id,
    label: entry.label,
    domain: entry.domain,
    productType: entry.productType,
    dialectFamily,
    connection: {
      host: entry.connection.host,
      port: entry.connection.port,
      database: entry.connection.database,
      user: entry.connection.user,
      filePath: entry.connection.filePath,
      ssl: entry.connection.ssl,
      rejectUnauthorized: entry.connection.rejectUnauthorized,
      ca: loadPemValue(
        entry.connection.ca,
        entry.connection.caFile,
        entry.connection.caFileEnv,
        baseDirectory,
        env,
        "CA",
      ),
      cert: loadPemValue(
        entry.connection.cert,
        entry.connection.certFile,
        entry.connection.certFileEnv,
        baseDirectory,
        env,
        "client certificate",
      ),
      key: loadPemValue(
        entry.connection.key,
        entry.connection.keyFile,
        entry.connection.keyFileEnv,
        baseDirectory,
        env,
        "client key",
      ),
      mode: entry.connection.mode,
      secretRef: entry.connection.secretRef,
    },
    exposedSchemas: entry.exposedSchemas,
    defaultSchema: entry.defaultSchema,
    capabilities: resolveCapabilities(dialectFamily, entry.capabilities),
    supportStatus,
  };
}

function loadPemValue(
  inlineValue: string | undefined,
  filePath: string | undefined,
  fileEnv: string | undefined,
  baseDirectory: string,
  env: NodeJS.ProcessEnv,
  label: string,
): string | undefined {
  const sourceCount = [inlineValue, filePath, fileEnv].filter(Boolean).length;
  if (sourceCount > 1) {
    throw new Error(
      `${label} must use exactly one of inline content, file, or file environment variable`,
    );
  }
  if (inlineValue) return inlineValue;
  if (fileEnv) {
    const value = env[fileEnv]?.trim();
    if (!value) {
      throw new Error(`${label} file environment variable is not set: ${fileEnv}`);
    }
    filePath = value;
  }
  if (!filePath) return undefined;

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseDirectory, filePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error(`${label} path is not a file: ${absolute}`);
  if (stat.size > 1024 * 1024) {
    throw new Error(`${label} file exceeds 1 MiB: ${absolute}`);
  }
  const value = fs.readFileSync(absolute, "utf8");
  if (!value.trim()) throw new Error(`${label} file is empty: ${absolute}`);
  return value;
}
