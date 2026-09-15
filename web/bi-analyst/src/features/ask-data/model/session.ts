const SESSION_KEY = "bi-analyst.sessionId";

export function getOrCreateSessionId(): string {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const id = newSessionId();
  window.localStorage.setItem(SESSION_KEY, id);
  return id;
}

export function rotateSessionId(): string {
  const id = newSessionId();
  window.localStorage.setItem(SESSION_KEY, id);
  return id;
}

function newSessionId(): string {
  return `sess-${crypto.randomUUID().slice(0, 8)}`;
}
