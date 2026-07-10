import { randomUUID } from "node:crypto";
import type { AuthenticatedPrincipal } from "../auth/types.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import type { RuntimeProfile } from "../config/types.js";

export interface RequestContext {
  requestId: string;
  traceId: string;
  principal: AuthenticatedPrincipal;
  sessionId?: string;
  deadlineAt: number;
  policySnapshot: AccessPolicy;
  runtimeProfile: RuntimeProfile;
  abortSignal: AbortSignal;
}

export interface CreateRequestContextInput {
  principal: AuthenticatedPrincipal;
  policySnapshot: AccessPolicy;
  runtimeProfile: RuntimeProfile;
  sessionId?: string;
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
  const timeoutMs =
    input.timeoutMs ?? input.runtimeProfile.environment === "test"
      ? 120_000
      : 120_000;

  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      controller.abort();
    } else {
      input.abortSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  return {
    requestId,
    traceId,
    principal: input.principal,
    sessionId: input.sessionId,
    deadlineAt,
    policySnapshot: input.policySnapshot,
    runtimeProfile: input.runtimeProfile,
    abortSignal: controller.signal,
  };
}

export function remainingMs(ctx: RequestContext): number {
  return Math.max(0, ctx.deadlineAt - Date.now());
}
