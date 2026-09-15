import { randomUUID } from "node:crypto";
import { AccessGateway, EntryIdempotencyStore, TenantRateLimiter, TokenAuthenticator } from "../../access";
import type { RagBotInput } from "../../type";

export function admittedInput(input: RagBotInput): RagBotInput {
  const gateway = new AccessGateway({
    authenticator: new TokenAuthenticator({
      test: { tenantId: input.tenantId ?? "tenant-a", principal: input.principal ?? "test-user" },
    }),
    idempotency: new EntryIdempotencyStore(),
    limiter: new TenantRateLimiter(),
  });
  const result = gateway.admit({
    credential: { token: "test" },
    messageId: randomUUID(),
    threadId: input.threadId,
    body: { ...input },
  });
  if (!result.ok) throw new Error(result.reason);
  return gateway.toGraphInput(result);
}
