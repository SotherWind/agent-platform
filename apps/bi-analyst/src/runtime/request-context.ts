import { randomUUID } from "node:crypto";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import type { RuntimeProfile } from "../config/types.js";

export interface RequestContext {
  requestId: string;
  traceId: string;
  principal: AuthenticatedPrincipal;
  sessionId?: string;
  /** 结构化澄清选项（服务端 ID），由 API 解析后注入 */
  clarificationChoice?: string;
  deadlineAt: number;
  policySnapshot: AccessPolicy;
  runtimeProfile: RuntimeProfile;
  abortSignal: AbortSignal;
  dispose(): void;
}

export interface CreateRequestContextInput {
  principal: AuthenticatedPrincipal;
  policySnapshot: AccessPolicy;
  runtimeProfile: RuntimeProfile;
  sessionId?: string;
  clarificationChoice?: string;
  requestId?: string;
  traceId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export function createRequestContext(
  input: CreateRequestContextInput,
): RequestContext {
  const requestId = input.requestId ?? `req-${randomUUID()}`;
  const traceId = input.traceId ?? requestId;
  const timeoutMs = input.timeoutMs ?? 120_000;

  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  const onParentAbort = () => controller.abort();
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      controller.abort();
    } else {
      input.abortSignal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    input.abortSignal?.removeEventListener("abort", onParentAbort);
  };

  return {
    requestId,
    traceId,
    principal: input.principal,
    sessionId: input.sessionId,
    clarificationChoice: input.clarificationChoice,
    deadlineAt,
    policySnapshot: input.policySnapshot,
    runtimeProfile: input.runtimeProfile,
    abortSignal: controller.signal,
    dispose,
  };
}

export function remainingMs(ctx: RequestContext): number {
  return Math.max(0, ctx.deadlineAt - Date.now());
}
