import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AnalyzeRequest } from "../auth/types.js";
import type { AuditLogger } from "../audit/logger.js";
import type { DataSourceRegistry } from "../datasource/registry.js";
import type { SecretProvider } from "../datasource/secrets.js";
import type { SchemaRetriever } from "../metadata/retriever.js";
import type { SessionStore } from "../session/store.js";

export const APP_ENVIRONMENTS = [
  "development",
  "test",
  "staging",
  "production",
] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export interface AppConfig {
  environment: AppEnvironment;
  port: number;
  maxRetryCount: number;
  requestTimeoutMs: number;
  configVersion: string;
}

export interface AuthProvider {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedPrincipal>;
  validateSession?(
    principal: AuthenticatedPrincipal,
    sessionId: string,
  ): Promise<void>;
}

export interface AuditSink {
  logger: AuditLogger;
}

export interface RuntimeProfile {
  environment: AppEnvironment;
  isLocal: boolean;
  authProvider: AuthProvider;
  secretProvider: SecretProvider;
  dataSourceRegistry: DataSourceRegistry;
  schemaRetriever: SchemaRetriever;
  checkpointer: BaseCheckpointSaver;
  auditSink: AuditSink;
  sessionStore: SessionStore;
}

export interface AnalyzeHandlerInput {
  request: AnalyzeRequest;
  principal: AuthenticatedPrincipal;
  requestId: string;
  traceId: string;
}
