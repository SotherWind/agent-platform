/**
 * 子进程级回归/诊断 harness：
 * - 独立启动一个 server 子进程，避免把宿主进程是否存活混在结果里；
 * - 在同一 thread 中连续执行两次动态订单查询；
 * - 断言两次 HTTP/SSE 完成、无 error frame，且第二次完成后 server 仍存活；
 * - 失败时只输出脱敏后的日志尾部。
 *
 * 默认使用当前 server/.env 的真实 LLM 配置。可用环境变量覆盖：
 *   CRASH_REPRO_USERNAME / CRASH_REPRO_PASSWORD
 *   CRASH_REPRO_PORT
 *   CRASH_REPRO_KEEP_DATA=true
 */
import "../src/env.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const tsxCli = join(serverRoot, "node_modules", "tsx", "dist", "cli.mjs");
const keepData = process.env.CRASH_REPRO_KEEP_DATA === "true";
const username = process.env.CRASH_REPRO_USERNAME ?? "demo";
const password = process.env.CRASH_REPRO_PASSWORD ?? "demo123";
const requestedPort = Number.parseInt(process.env.CRASH_REPRO_PORT ?? "0", 10);
let activeChild: ChildProcessWithoutNullStreams | undefined;
let activeOutput: (() => string) | undefined;

type Frame = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function redact(text: string): string {
  let result = text;
  for (const value of Object.values(process.env)) {
    if (value && value.length >= 8) result = result.split(value).join("<REDACTED>");
  }
  return result
    .replace(/(authorization|api[-_ ]?key|password|secret|token)(\s*[:=]\s*)\S+/gi, "$1$2<REDACTED>")
    .replace(/(Bearer\s+)\S+/gi, "$1<REDACTED>");
}

function logTail(output: string, maxLines = 100): string {
  return redact(output).split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
}

async function freePort(): Promise<number> {
  if (requestedPort > 0) return requestedPort;
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  assert(port > 0, "无法分配诊断端口");
  return port;
}

function collectChildOutput(child: ChildProcessWithoutNullStreams): {
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  return {
    output: () => `${stdout}\n${stderr}`,
    exited,
  };
}

async function waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams, exited: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      exited.then((value) => ({ exited: value })),
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })
        .then((response) => ({ response }))
        .catch(() => ({ response: undefined })),
    ]);
    if ("exited" in result) throw new Error(`server 在探活前退出: ${JSON.stringify(result.exited)}`);
    if (result.response?.status === 200) return;
    await delay(200);
  }
  throw new Error(`server 启动超时，child.connected=${child.connected}`);
}

async function readSse(response: Response): Promise<Frame[]> {
  assert(response.body, "SSE 响应无 body");
  const frames: Frame[] = [];
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += new TextDecoder().decode(chunk);
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const parsed: unknown = JSON.parse(line.slice("data: ".length));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            frames.push(parsed as Frame);
          }
        } catch {
          throw new Error(`SSE 帧不是合法 JSON: ${line.slice(0, 120)}`);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return frames;
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `登录失败 HTTP ${response.status}`);
  const payload = await response.json() as { token?: unknown };
  assert(typeof payload.token === "string" && payload.token.length > 0, "登录未返回 token");
  return payload.token;
}

async function chat(baseUrl: string, token: string, threadId: string, messageId: string, text: string): Promise<Frame[]> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages: [{ id: messageId, role: "user", parts: [{ type: "text", text }] }],
      threadId,
      messageId,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  assert(response.status === 200, `订单查询 HTTP ${response.status}`);
  assert(response.headers.get("content-type")?.includes("text/event-stream"), "订单查询未返回 SSE");
  const frames = await readSse(response);
  const finish = frames.find((frame) => frame.type === "finish");
  assert(finish?.finishReason === "stop", `SSE 未正常结束: ${JSON.stringify(finish)}`);
  assert(!frames.some((frame) => frame.type === "error"), "SSE 包含 error frame");
  assert(frames.some((frame) => frame.type === "text-delta"), "SSE 未返回文本");
  return frames;
}

async function main(): Promise<void> {
  assert(process.env.USE_FAKE_LLM !== "true", "该 harness 要求真实 LLM，请移除 USE_FAKE_LLM=true");
  for (const key of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_NAME"]) {
    assert(process.env[key]?.trim(), `缺少真实 LLM 配置: ${key}`);
  }

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "ragbot-crash-repro-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [tsxCli, "src/main.ts"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAGBOT_DATA_DIR: dataDir,
      AUTO_INGEST: "false",
      STREAM_CHUNK_DELAY_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  activeChild = child;
  const childState = collectChildOutput(child);
  activeOutput = childState.output;

  const stopChild = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await Promise.race([childState.exited, delay(5_000)]);
  };

  try {
    await waitForHealth(baseUrl, child, childState.exited);
    const token = await login(baseUrl);
    const threadId = `crash-repro-${Date.now()}`;
    const first = await chat(
      baseUrl,
      token,
      threadId,
      `${threadId}-1`,
      "请查询订单 order-demo-private 当前状态、金额和可退款金额。",
    );
    assert(child.exitCode === null && child.signalCode === null, "第一次订单查询后 server 子进程已退出");

    const second = await chat(
      baseUrl,
      token,
      threadId,
      `${threadId}-2`,
      "请再查询订单 order-demo-refund 当前状态、金额和可退款金额。",
    );
    assert(child.exitCode === null && child.signalCode === null, "第二次订单查询后 server 子进程已退出");
    await delay(1_000);
    assert(child.exitCode === null && child.signalCode === null, "第二次响应完成后 1 秒内 server 子进程退出");
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    assert(health.status === 200, `第二次响应后探活失败 HTTP ${health.status}`);

    console.log(
      `[crash-repro] PASS mode=real firstFrames=${first.length} secondFrames=${second.length} ` +
      `pid=${child.pid} dataDir=${keepData ? dataDir : "<temporary>"}`,
    );
  } finally {
    await stopChild();
    activeChild = undefined;
    if (!keepData) rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(`[crash-repro] FAIL ${error instanceof Error ? error.message : String(error)}`);
  await delay(100);
  const output = activeOutput?.();
  if (output?.trim()) console.error(`[crash-repro] child-log-tail\n${logTail(output)}`);
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill();
  process.exitCode = 1;
});
