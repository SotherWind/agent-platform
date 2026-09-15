import type { ServerConfig } from "./config.js";

/**
 * 断句自然停顿：句末标点后多停一会儿，模拟真人打字节奏。
 * 返回该片段发送后应间隔的毫秒数。
 */
export function pauseFor(text: string, base: number): number {
  const last = text.slice(-1);
  if (last === "\n") return base * 4;
  if ("。！？；".includes(last)) return base * 3;
  if ("，、：,;:".includes(last)) return base * 2;
  return base;
}

/** 把一段文本按 chunkSize/delayMs 切成带节奏的片段流（客户端断开即停） */
export async function* pacedPieces(
  text: string,
  options: { chunkSize: number; delayMs: number; isCancelled?: () => boolean },
): AsyncGenerator<string> {
  const size = Math.max(1, Math.trunc(options.chunkSize));
  const delay = Math.max(0, options.delayMs);
  for (let i = 0; i < text.length; i += size) {
    if (options.isCancelled?.()) return;
    const piece = text.slice(i, i + size);
    if (!piece) continue;
    if (delay > 0 && !options.isCancelled?.()) {
      await new Promise((resolve) => setTimeout(resolve, pauseFor(piece, delay)));
    }
    yield piece;
  }
}

/** server 配置里的流控参数（供 http 层传入） */
export function streamPacingOf(config: ServerConfig): { chunkSize: number; delayMs: number } {
  return { chunkSize: config.streamChunkSize, delayMs: config.streamChunkDelayMs };
}
