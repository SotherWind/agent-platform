import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { HumanMessage } from "@langchain/core/messages";
import type { BootstrapResult } from "../bootstrap/index.js";
import { parseAnalyzeRequest, AuthError, buildSessionKey } from "../auth/principal.js";
import { createRequestContext } from "../runtime/request-context.js";
import { emitAuditEvent } from "../audit/events.js";
import { AppError, toClientError } from "../errors/app-error.js";
import { loadPolicyForPrincipal } from "../bootstrap/local-profile.js";
import type { RequestContext } from "../runtime/request-context.js";
import { buildGraph, type BiAnalystGraph } from "../agent.js";

export interface AnalyzeResponseBody {
  finalAnswer: string;
  chartSpec?: unknown;
  meta: {
    queryPath: string | null;
    confidence: number | null;
    requestId: string;
    traceId: string;
    dataFreshness?: {
      dataAsOf: string;
      timezone: string;
      status: "fresh" | "stale" | "unknown";
      warnings: string[];
    };
  };
  needsClarification?: boolean;
  clarification?: unknown;
}

export interface AppServer {
  server: ReturnType<typeof createServer>;
  graph: BiAnalystGraph;
  profile: BootstrapResult["profile"];
  close(): Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >);
      } catch {
        reject(new AppError("请求体必须是 JSON", "validation_error", 400));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function headersRecord(req: IncomingMessage): Record<string, string | string[] | undefined> {
  return req.headers;
}

function hasDebugRole(ctx: RequestContext): boolean {
  return ctx.principal.roles.includes("BI_QUERY_DEBUG");
}

export function createAppServer(bootstrap: BootstrapResult): AppServer {
  const { profile, config, localResources } = bootstrap;
  const db = localResources?.db;
  if (!db && profile.isLocal) {
    throw new AppError("本地 Profile 缺少数据库资源", "config_invalid", 500, false);
  }

  const graph = buildGraph({
    db: db!,
    runtimeProfile: profile,
    schemaRetriever: profile.schemaRetriever,
    checkpointer: profile.checkpointer,
  });

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        writeJson(res, 200, { status: "ok", environment: config.environment });
        return;
      }

      if (req.method === "POST" && req.url === "/api/analyze") {
        const principal = await profile.authProvider.authenticate(
          headersRecord(req),
        );
        const body = await readJsonBody(req);
        const analyzeRequest = parseAnalyzeRequest(body);
        const policySnapshot = loadPolicyForPrincipal(principal, profile);

        if (analyzeRequest.sessionId) {
          profile.sessionStore.registerOrValidate(
            principal,
            analyzeRequest.sessionId,
            policySnapshot.policyVersion,
          );
        }

        const requestContext = createRequestContext({
          principal,
          policySnapshot,
          runtimeProfile: profile,
          sessionId: analyzeRequest.sessionId,
          timeoutMs: config.requestTimeoutMs,
        });

        emitAuditEvent({
          event: "request.accepted",
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          sessionId: analyzeRequest.sessionId,
        });
        emitAuditEvent({
          event: "auth.validated",
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
        });
        emitAuditEvent({
          event: "policy.loaded",
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          metadata: { policyVersion: policySnapshot.policyVersion },
        });

        const threadId = analyzeRequest.sessionId
          ? buildSessionKey(
              principal.tenantId,
              principal.subjectId,
              analyzeRequest.sessionId,
            )
          : buildSessionKey(
              principal.tenantId,
              principal.subjectId,
              requestContext.requestId,
            );

        const result = await graph.invoke(
          { messages: [new HumanMessage(analyzeRequest.query)] },
          {
            configurable: {
              requestContext,
              thread_id: threadId,
            },
          },
        );

        emitAuditEvent({
          event: "answer.completed",
          requestId: requestContext.requestId,
          traceId: requestContext.traceId,
          subjectId: principal.subjectId,
          tenantId: principal.tenantId,
          dataSourceId: result.dataSourceId || undefined,
          metadata: {
            queryPath: result.queryPath,
            retryCount: result.retryCount,
          },
        });

        const response: AnalyzeResponseBody = {
          finalAnswer: result.finalAnswer ?? "",
          chartSpec: result.chartSpec ?? undefined,
          meta: {
            queryPath: result.queryPath,
            confidence: result.confidence,
            requestId: requestContext.requestId,
            traceId: requestContext.traceId,
            dataFreshness: result.dataFreshness ?? {
              dataAsOf: new Date().toISOString(),
              timezone: "Asia/Shanghai",
              status: "unknown",
              warnings: ["元数据新鲜度不可用"],
            },
          },
          needsClarification: Boolean(result.clarification),
          clarification: result.clarification ?? undefined,
        };

        if (hasDebugRole(requestContext) && result.generatedSql) {
          (response as AnalyzeResponseBody & { debugMeta?: unknown }).debugMeta =
            {
              dataSourceId: result.dataSourceId,
              generatedSql: result.generatedSql,
            };
        }

        writeJson(res, 200, response);
        return;
      }

      writeJson(res, 404, { error: "Not Found", code: "not_found" });
    } catch (error) {
      emitAuditEvent({
        event: "request.failed",
        requestId: "unknown",
        traceId: "unknown",
        subjectId: "unknown",
        tenantId: "unknown",
        metadata: {
          message: error instanceof Error ? error.message : String(error),
        },
      });

      if (error instanceof AuthError) {
        const statusCode =
          error.code === "forged_identity" || error.code === "unauthenticated"
            ? 401
            : error.code === "policy_stale"
              ? 409
              : 403;
        writeJson(res, statusCode, { error: error.message, code: error.code });
        return;
      }

      const client = toClientError(error);
      writeJson(res, client.statusCode, client.body);
    }
  });

  return {
    server,
    graph,
    profile,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (localResources) {
        localResources.db.close();
      }
    },
  };
}

export function startAppServer(bootstrap: BootstrapResult, port: number) {
  const app = createAppServer(bootstrap);
  app.server.listen(port, () => {
    console.info(`[bi-analyst] listening on :${port}`);
  });
  return app;
}
