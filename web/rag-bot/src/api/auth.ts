/**
 * 登录态管理：token 存 localStorage，之后所有 /api 请求带 Bearer。
 * 服务端重启会导致已签发 token 失效，捕获 401 时引导重新登录。
 */

const TOKEN_KEY = "ragbot.token";
const USERNAME_KEY = "ragbot.username";
const THREAD_KEY = "ragbot.threadId";

export interface LoginResult {
  token: string;
  username: string;
  tenantId: string;
  expiresAt: number;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY);
}

export function isLoggedIn(): boolean {
  return Boolean(getToken());
}

export function storeLogin(result: LoginResult): void {
  localStorage.setItem(TOKEN_KEY, result.token);
  localStorage.setItem(USERNAME_KEY, result.username);
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const response = await fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    token?: string;
    username?: string;
    tenantId?: string;
    expiresAt?: number;
  };
  if (!response.ok || !payload.token) {
    throw new Error(payload.error ?? `登录失败（${response.status}）`);
  }
  const result: LoginResult = {
    token: payload.token,
    username: payload.username ?? username,
    tenantId: payload.tenantId ?? "",
    expiresAt: payload.expiresAt ?? 0,
  };
  storeLogin(result);
  return result;
}

/** 会话线程 ID：同一浏览器同一会话；「新会话」时重新生成 */
export function getThreadId(): string {
  let threadId = localStorage.getItem(THREAD_KEY);
  if (!threadId) {
    threadId = newThreadId();
  }
  return threadId;
}

export function newThreadId(): string {
  const threadId = crypto.randomUUID();
  localStorage.setItem(THREAD_KEY, threadId);
  return threadId;
}
