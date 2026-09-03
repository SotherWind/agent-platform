/**
 * 测试用 fake LLM。
 *
 * 支持：
 * - 固定回复 / 按 stage 分派不同回复
 * - 抛错（用于 T6.1 降级链）
 * - 记录全部调用（用于断言 prompt 内容、调用次数）
 */
import { countTokens } from "../tokens";
import type { Llm, LlmRequest, LlmResponse, ModelTier } from "./types";

export interface FakeLlmOptions {
  /** 固定回复。给了 replies 时按调用顺序取，取完用最后一个 */
  reply?: string;
  replies?: string[];
  /** 按 stage 覆盖回复，优先级高于 reply/replies */
  byStage?: Record<string, string>;
  model?: string;
  tier?: ModelTier;
  /** 抛出该错误（或每次都抛） */
  failWith?: unknown;
  /** 第 n 次调用才失败（1-based），用于测试重试后成功 */
  failOnCall?: number;
  /** 流式产出（默认按字符切分回复） */
  streamChunks?: string[];
}

export interface FakeLlmCall {
  stage?: string;
  system?: string;
  prompt: string;
  json?: boolean;
}

export interface FakeLlm extends Llm {
  readonly calls: FakeLlmCall[];
  /** 按 stage 过滤调用记录 */
  callsFor(stage: string): FakeLlmCall[];
  /** 全部调用拼接出的提示词文本，便于断言 prompt 内容 */
  allPrompts(): string;
}

export function createFakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const {
    reply = "",
    replies,
    byStage,
    model = "fake-model",
    tier = "small",
    failWith,
    failOnCall,
    streamChunks,
  } = options;

  const calls: FakeLlmCall[] = [];
  let n = 0;

  const pickText = (req: LlmRequest): string => {
    if (byStage && req.stage && req.stage in byStage) return byStage[req.stage];
    if (replies && replies.length > 0) {
      return replies[Math.min(n - 1, replies.length - 1)];
    }
    return reply;
  };

  return {
    model,
    tier,
    calls,
    callsFor: (stage: string) => calls.filter((c) => c.stage === stage),
    allPrompts: () => calls.map((c) => `${c.system ?? ""}\n${c.prompt}`).join("\n"),
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      n += 1;
      calls.push({
        stage: req.stage,
        system: req.system,
        prompt: req.prompt,
        json: req.json,
      });

      if (failWith !== undefined && (failOnCall === undefined || failOnCall === n)) {
        throw failWith;
      }

      const text = pickText(req);
      const promptTokens =
        countTokens(req.system ?? "") + countTokens(req.prompt);
      const completionTokens = countTokens(text);

      return {
        text,
        model,
        tier,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    },
    async *stream(req: LlmRequest): AsyncIterable<string> {
      n += 1;
      calls.push({
        stage: req.stage,
        system: req.system,
        prompt: req.prompt,
        json: req.json,
      });
      if (failWith !== undefined && (failOnCall === undefined || failOnCall === n)) {
        throw failWith;
      }
      const text = pickText(req);
      const chunks = streamChunks ?? Array.from(text);
      for (const chunk of chunks) yield chunk;
    },
  };
}
