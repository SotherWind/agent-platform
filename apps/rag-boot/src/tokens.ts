/**
 * Token 计数。
 *
 * T2.2 明确要求「token 计数用 tokenizer 而非字符数估算」——
 * 中文场景下字符数估算是错的：1 个汉字 ≈ 0.6-1 token，而 1 个英文单词 ≈ 1.3 token，
 * 用 chars/4 估中文会低估近一倍，context 预算形同虚设。
 *
 * 性能注记（T2.2 截断测试暴露）：js-tiktoken 的 BPE 对长中文文本是 **O(n²)**
 * （实测 900 字 ≈ 0.5s、1800 字 ≈ 2s、3600 字 ≈ 8s、7200 字 ≈ 33s）。
 * 知识 chunk 常超过这个量级，全量精算会把检索链路卡死。
 * 因此超过 ENCODER_MAX_CHARS 的文本改走**保守估算**：
 * CJK 1 字 ≈ 1 token（实际 0.6-1，只会高估不会低估），其余 4 字符 ≈ 1 token，
 * 预算硬上限不失守；短文本仍走精确 tokenizer。
 */
import { encodingForModel, type Tiktoken } from "js-tiktoken";

/** 超过该长度的文本不再用 tiktoken 精算（O(n²) 病态区），改走保守估算 */
const ENCODER_MAX_CHARS = 256;

let encoder: Tiktoken | null | undefined;

function getEncoder(): Tiktoken | null {
  if (encoder !== undefined) return encoder;
  try {
    encoder = encodingForModel("gpt-4o");
  } catch {
    encoder = null;
  }
  return encoder;
}

/**
 * 统计文本的 token 数。
 * 短文本用 tokenizer 精算；长文本（> ENCODER_MAX_CHARS）或编码器不可用时
 * 降级为保守估算：宁可高估也不低估。
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  if (text.length > ENCODER_MAX_CHARS) return estimateTokens(text);
  const enc = getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      /* fall through to estimate */
    }
  }
  return estimateTokens(text);
}

/** 估算：CJK 1 字 1 token，其余 4 字符 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/** 找最大的前缀长度，使估算 token 数 ≤ maxTokens（二分，O(n log n)） */
function longestPrefixWithin(text: string, maxTokens: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.min(hi, Math.ceil((lo + hi) / 2));
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

/** 按 token 上限截断文本（用于单条 chunk 超预算时截断而非整条丢弃，T2.2） */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (countTokens(text) <= maxTokens) return text;

  // 长文本：tiktoken O(n²) 病态区，用估算 + 二分截断，保证估算 token ≤ maxTokens
  if (text.length > ENCODER_MAX_CHARS) {
    return longestPrefixWithin(text, maxTokens);
  }

  const enc = getEncoder();
  if (enc) {
    try {
      return enc.decode(enc.encode(text).slice(0, maxTokens));
    } catch {
      /* fall through */
    }
  }
  // 短文本且编码器不可用：同样按估算二分截断
  return longestPrefixWithin(text, maxTokens);
}

/** 释放 tokenizer（测试 teardown 用） */
export function disposeTokenizer(): void {
  const enc = encoder as { free?: () => void } | null | undefined;
  if (enc && typeof enc.free === "function") enc.free();
  encoder = undefined;
}
