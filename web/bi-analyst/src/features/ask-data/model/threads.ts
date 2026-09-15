import type { AskDataUIMessage } from "./types";

export interface ThreadRecord {
  id: string;
  title: string;
  updatedAt: string;
  messages: AskDataUIMessage[];
}

const THREADS_KEY = "bi-analyst.threads.v1";
const ACTIVE_KEY = "bi-analyst.activeThread";

export function readThreads(): ThreadRecord[] {
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ThreadRecord[];
  } catch {
    return [];
  }
}

export function writeThreads(threads: ThreadRecord[]): void {
  window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(0, 30)));
}

export function readActiveThreadId(): string | null {
  return window.localStorage.getItem(ACTIVE_KEY);
}

export function writeActiveThreadId(id: string): void {
  window.localStorage.setItem(ACTIVE_KEY, id);
}

export function createThread(id: string): ThreadRecord {
  return {
    id,
    title: "新会话",
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

export function titleFromMessages(messages: AskDataUIMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "新会话";
  const text = first.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.slice(0, 18) || "新会话";
}
