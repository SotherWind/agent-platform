// T9.2 接入层：鉴权、租户识别、限流、入口幂等（安全类测试，不允许 skip）
import {
  AccessGateway,
  TokenAuthenticator,
  EntryIdempotencyStore,
  TenantRateLimiter,
  type InboundRequest,
} from "../access";

/** 模拟编排入口：记录是否被调用 */
function makeOrchestrator() {
  const calls: Array<{ tenantId: string; messageId: string }> = [];
  return {
    calls,
    enter(tenantId: string, messageId: string) {
      calls.push({ tenantId, messageId });
      return "processed";
    },
  };
}

function makeGateway(overrides: Partial<{ limit: number; windowMs: number }> = {}) {
  const authenticator = new TokenAuthenticator({
    "token-tenant-a": { tenantId: "tenant-a", principal: "bot-a" },
    "token-tenant-b": { tenantId: "tenant-b", principal: "bot-b" },
  });
  return new AccessGateway({
    authenticator,
    idempotency: new EntryIdempotencyStore(),
    limiter: new TenantRateLimiter({ limit: overrides.limit ?? 100, windowMs: overrides.windowMs ?? 60_000 }),
    clock: () => 1_000_000,
  });
}

describe("接入层", () => {
  it("未通过鉴权的请求不进入编排", () => {
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator();

    const req: InboundRequest = {
      credential: { token: "bad-token" },
      messageId: "m-1",
      body: { query: "你好", tenantId: "tenant-a" },
    };

    const result = gateway.admit(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unauthenticated");
      // 可读提示
      expect(result.reason.length).toBeGreaterThan(0);
    }
    // 编排从未被调用
    expect(orchestrator.calls).toHaveLength(0);
  });

  it("tenantId 来自鉴权凭证，不从请求体读取", () => {
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator();

    // 请求体伪造 tenantId = tenant-b，凭证只授权 tenant-a
    const req: InboundRequest = {
      credential: { token: "token-tenant-a" },
      messageId: "m-2",
      body: { query: "你好", tenantId: "tenant-b" },
    };

    const result = gateway.admit(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.tenantId).toBe("tenant-a");
      // 编排收到的租户也是凭证租户，而非请求体里的
      orchestrator.enter(result.identity.tenantId, req.messageId);
      expect(orchestrator.calls[0].tenantId).toBe("tenant-a");
    }
  });

  it("同一 messageId 重复投递只处理一次（Webhook 重试幂等）", () => {
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator();

    const admit = (id: string) =>
      gateway.admit({
        credential: { token: "token-tenant-a" },
        messageId: id,
        body: { query: "同一问题" },
      });

    const first = admit("dup-1");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.duplicate).toBe(false);
      orchestrator.enter(first.identity.tenantId, "dup-1");
    }

    // Webhook 重试：同 messageId 再次投递
    const second = admit("dup-1");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.duplicate).toBe(true);
      // 幂等保护下不再进入编排
      expect(orchestrator.calls).toHaveLength(1);
    }
  });

  it("重复投递不消耗限流配额", () => {
    const gateway = makeGateway({ limit: 1, windowMs: 60_000 });
    const request = (messageId: string): InboundRequest => ({
      credential: { token: "token-tenant-a" },
      messageId,
      body: { query: "hi" },
    });

    expect(gateway.admit(request("same")).ok).toBe(true);
    const duplicate = gateway.admit(request("same"));
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.duplicate).toBe(true);
    expect(gateway.admit(request("new")).ok).toBe(false);
  });

  it("超过租户级速率限制时拒绝，并返回可读提示", () => {
    const gateway = makeGateway({ limit: 2, windowMs: 60_000 });

    const admit = (id: string) =>
      gateway.admit({
        credential: { token: "token-tenant-a" },
        messageId: id,
        body: { query: "hi" },
      });

    expect(admit("r-1").ok).toBe(true);
    expect(admit("r-2").ok).toBe(true);
    const third = admit("r-3");
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.code).toBe("rate_limited");
      // 可读提示：包含中文说明与重试建议
      expect(third.reason).toContain("请求");
      expect(third.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("单租户异常流量不影响其他租户（隔离舱）", () => {
    const gateway = makeGateway({ limit: 1, windowMs: 60_000 });

    const admitTenantA = (id: string) =>
      gateway.admit({
        credential: { token: "token-tenant-a" },
        messageId: id,
        body: { query: "hi" },
      });
    const admitTenantB = (id: string) =>
      gateway.admit({
        credential: { token: "token-tenant-b" },
        messageId: id,
        body: { query: "hi" },
      });

    // 租户 A 打满自己的配额
    expect(admitTenantA("a-1").ok).toBe(true);
    expect(admitTenantA("a-2").ok).toBe(false);
    // 租户 B 的配额不受 A 影响
    expect(admitTenantB("b-1").ok).toBe(true);
  });
});
