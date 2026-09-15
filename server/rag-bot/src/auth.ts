/**
 * 鉴权服务：登录换 token + token → Principal 解析。
 *
 * 边界说明（与拷问定稿一致）：
 * - 「登录人的 token」：人通过 /login（账号表在 .env）换取；服务内存持有，重启失效需重登。
 * - 「系统的 token」：直接配发（RAGBOT_SYSTEM_TOKENS），API Key 语义，机器对机器无需登录。
 * - 两类 token 在 authenticate() 里一视同仁，AccessGateway 不关心签发方式；
 *   未来接真 SSO 时，替换此处的签发/校验实现即可，下游零改动。
 */
import { randomBytes } from "node:crypto";
import type { Credential, Principal } from "@agent-platform/rag-boot";
import type { ServerConfig, SystemTokenEntry, UserEntry } from "./config.js";

export interface IssuedToken {
  token: string;
  username: string;
  tenantId: string;
  expiresAt: number;
}

export interface AuthenticatorLike {
  authenticate(cred: Credential): Principal | null;
}

export class AuthService implements AuthenticatorLike {
  private readonly users: Map<string, UserEntry>;
  private readonly systemTokens: Map<string, Principal>;
  private readonly issued = new Map<string, IssuedToken>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    config: Pick<ServerConfig, "users" | "systemTokens" | "tokenTtlSeconds">,
    options: { now?: () => number; randomToken?: (size: number) => string } = {},
  ) {
    this.users = new Map(config.users.map((u) => [u.username, u]));
    this.systemTokens = new Map(
      config.systemTokens.map((t: SystemTokenEntry): [string, Principal] => [
        t.token,
        { tenantId: t.tenantId, principal: t.principal,
          ...(t.knowledgeScope ? { knowledgeScope: structuredClone(t.knowledgeScope) } : {}) },
      ]),
    );
    this.ttlMs = config.tokenTtlSeconds * 1000;
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? ((size: number) => randomBytes(size).toString("hex"));
  }

  private readonly randomToken: (size: number) => string;

  /** 账号密码登录；成功返回新签发 token，失败返回 null（不区分"用户不存在"与"密码错误"） */
  login(username: string, password: string): IssuedToken | null {
    const user = this.users.get(username);
    if (!user || user.password !== password) return null;

    this.evictExpired();
    const token = this.randomToken(24);
    const issued: IssuedToken = {
      token,
      username: user.username,
      tenantId: user.tenantId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.issued.set(token, issued);
    return issued;
  }

  /** token → Principal；登录签发与系统配发统一解析。租户身份只来自凭证 */
  authenticate(cred: Credential): Principal | null {
    const token = cred?.token;
    if (!token) return null;

    const system = this.systemTokens.get(token);
    if (system) return structuredClone(system);

    const issued = this.issued.get(token);
    if (!issued) return null;
    if (issued.expiresAt <= this.now()) {
      this.issued.delete(token);
      return null;
    }
    const scope = this.users.get(issued.username)?.knowledgeScope;
    return { tenantId: issued.tenantId, principal: issued.username,
      ...(scope ? { knowledgeScope: structuredClone(scope) } : {}) };
  }

  /** 从 Bearer 头提取 token（供 HTTP 层调用） */
  static tokenFromAuthorizationHeader(header: string | undefined): string | null {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1]!.trim() : null;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [token, issued] of this.issued) {
      if (issued.expiresAt <= now) this.issued.delete(token);
    }
  }
}
