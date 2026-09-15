/**
 * 鉴权与接入网关单元测试（不碰网络、不碰 sqlite）。
 */
import { describe, expect, it } from "vitest";
import { buildAccessGateway } from "../src/gateway.js";
import { AuthService } from "../src/auth.js";
import type { ServerConfig } from "../src/config.js";

const baseConfig = {
  users: [
    { username: "alice", password: "alice123", tenantId: "tenant-a" },
    { username: "bob", password: "bob123", tenantId: "tenant-b" },
  ],
  systemTokens: [{ token: "sys-token-1", tenantId: "tenant-sys", principal: "order-system" }],
  tokenTtlSeconds: 60,
} satisfies Pick<ServerConfig, "users" | "systemTokens" | "tokenTtlSeconds">;

function makeAuth(): AuthService {
  let counter = 0;
  return new AuthService(baseConfig, {
    now: () => 1_000_000,
    randomToken: () => `test-token-${String((counter += 1)).padStart(3, "0")}`,
  });
}

describe("AuthService", () => {
  it("正确账号密码 → 签发 token，authenticate 还原租户身份", () => {
    const auth = makeAuth();
    const issued = auth.login("alice", "alice123");
    expect(issued).not.toBeNull();
    expect(issued!.tenantId).toBe("tenant-a");

    const principal = auth.authenticate({ token: issued!.token });
    expect(principal).toEqual({ tenantId: "tenant-a", principal: "alice" });
  });

  it("密码错误 / 用户不存在 → 统一返回 null（不泄露存在性）", () => {
    const auth = makeAuth();
    expect(auth.login("alice", "wrong")).toBeNull();
    expect(auth.login("nobody", "whatever")).toBeNull();
  });

  it("系统 token 直接通过（API Key 语义，无需登录）", () => {
    const auth = makeAuth();
    const principal = auth.authenticate({ token: "sys-token-1" });
    expect(principal).toEqual({ tenantId: "tenant-sys", principal: "order-system" });
  });

  it("过期 token → 拒绝并清除", () => {
    let now = 1_000_000;
    const auth = new AuthService(baseConfig, {
      now: () => now,
      randomToken: () => "expiring-token",
    });
    const issued = auth.login("alice", "alice123");
    expect(issued).not.toBeNull();

    now += 61_000; // 超过 60s TTL
    expect(auth.authenticate({ token: "expiring-token" })).toBeNull();
  });

  it("未知 / 空 token → null", () => {
    const auth = makeAuth();
    expect(auth.authenticate({ token: "nope" })).toBeNull();
    expect(auth.authenticate({ token: "" })).toBeNull();
  });

  it("Bearer 头解析", () => {
    expect(AuthService.tokenFromAuthorizationHeader("Bearer abc")).toBe("abc");
    expect(AuthService.tokenFromAuthorizationHeader("bearer abc")).toBe("abc");
    expect(AuthService.tokenFromAuthorizationHeader("Basic abc")).toBeNull();
    expect(AuthService.tokenFromAuthorizationHeader(undefined)).toBeNull();
  });
});

describe("AccessGateway 装配", () => {
  it("有效 token → admit 通过，身份来自凭证", () => {
    const auth = makeAuth();
    const issued = auth.login("bob", "bob123")!;
    const gateway = buildAccessGateway(auth);

    const result = gateway.admit({
      credential: { token: issued.token },
      messageId: "m-1",
      body: { query: "你好", tenantId: "spoofed-tenant" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({ tenantId: "tenant-b", principal: "bob" });
      expect(result.duplicate).toBe(false);
    }
  });

  it("无效 token → unauthenticated（body 里的 tenantId 永远不被采信）", () => {
    const gateway = buildAccessGateway(makeAuth());
    const result = gateway.admit({
      credential: { token: "forged" },
      messageId: "m-2",
      body: { query: "你好", tenantId: "tenant-a" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthenticated");
  });

  it("同 messageId 重复提交 → duplicate=true（幂等）", () => {
    const auth = makeAuth();
    const issued = auth.login("alice", "alice123")!;
    const gateway = buildAccessGateway(auth);
    const request = {
      credential: { token: issued.token },
      messageId: "m-dup",
      body: { query: "第一次" },
    };

    expect(gateway.admit(request).ok).toBe(true);
    const second = gateway.admit(request);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.duplicate).toBe(true);
    expect(gateway.admit({ ...request, body: { query: "不同内容" } })).toMatchObject({
      ok: false, code: "message_conflict",
    });
  });

  it("同租户超限 → rate_limited，且不影响其他租户", () => {
    const auth = makeAuth();
    const gateway = buildAccessGateway(auth, { rateLimitPerMinute: 2 });

    const login = (name: string) => auth.login(name, `${name}123`)!.token;
    const tokenA = login("alice");
    const tokenB = login("bob");

    expect(gateway.admit({ credential: { token: tokenA }, messageId: "a1", body: { query: "q" } }).ok).toBe(true);
    expect(gateway.admit({ credential: { token: tokenA }, messageId: "a2", body: { query: "q" } }).ok).toBe(true);
    const third = gateway.admit({ credential: { token: tokenA }, messageId: "a3", body: { query: "q" } });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("rate_limited");

    // 租户 B 不受 A 配额影响（隔离舱）
    expect(gateway.admit({ credential: { token: tokenB }, messageId: "b1", body: { query: "q" } }).ok).toBe(true);
  });
});
