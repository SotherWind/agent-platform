/**
 * 真实 LLM：OpenAI 兼容协议（@langchain/openai）
 *
 * 只在显式构造时才会 import 本模块（agent.ts 懒加载），
 * 避免单元测试被 @langchain/openai 的 3s 冷启动拖慢。
 */
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { countTokens } from "../tokens";
import { LlmConfigError, LlmTimeoutError } from "../errors";
import type { Llm, LlmRequest, LlmResponse, ModelTier } from "./types";

export interface ChatLlmConfig {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  tier?: ModelTier;
}

/** 从配置或 .env 构造 OpenAI 兼容 LLM */
export function createChatLlm(config: ChatLlmConfig): Llm {
  const apiKey = config.apiKey ?? process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new LlmConfigError(
      "Missing LLM API key: set MODEL_API_KEY in .env or pass apiKey.",
    );
  }

  const tier = config.tier ?? "small";
  const client = new ChatOpenAI({
    model: config.model,
    apiKey,
    configuration: config.baseUrl
      ? { baseURL: config.baseUrl }
      : process.env.MODEL_BASE_URL
        ? { baseURL: process.env.MODEL_BASE_URL }
        : undefined,
    temperature: config.temperature ?? 0.2,
    maxTokens: config.maxTokens,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // 重试交给 T6.1 降级链统一决策，避免两层重试叠加
  });

  return {
    model: config.model,
    tier,
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      const messages = [
        ...(req.system ? [new SystemMessage(req.system)] : []),
        new HumanMessage(req.prompt),
      ];

      try {
        const res = await client.invoke(messages, {
          ...(req.json ? { response_format: { type: "json_object" as const } } : {}),
        });

        const text =
          typeof res.content === "string"
            ? res.content
            : Array.isArray(res.content)
              ? res.content
                  .map((c) => (typeof c === "string" ? c : "text" in c ? c.text : ""))
                  .join("")
              : String(res.content ?? "");

        const usage = (res as { usage_metadata?: Record<string, number> })
          .usage_metadata;
        const promptTokens =
          usage?.input_tokens ?? countTokens(req.system ?? "") + countTokens(req.prompt);
        const completionTokens = usage?.output_tokens ?? countTokens(text);

        return {
          text,
          model: config.model,
          tier,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        };
      } catch (err) {
        // 归一化为 AgentError，保住 retryable 决策能力（T0.3）
        throw new LlmTimeoutError(
          `LLM invoke failed (${config.model}): ${err instanceof Error ? err.message : String(err)}`,
          { stage: req.stage ?? "generate", cause: err },
        );
      }
    },
    async *stream(req: LlmRequest): AsyncIterable<string> {
      const messages = [
        ...(req.system ? [new SystemMessage(req.system)] : []),
        new HumanMessage(req.prompt),
      ];
      try {
        for await (const chunk of await client.stream(messages)) {
          const c = chunk.content;
          if (typeof c === "string") yield c;
          else if (Array.isArray(c)) {
            for (const part of c) {
              if (typeof part === "string") yield part;
              else if (part && typeof part === "object" && "text" in part) {
                yield String(part.text);
              }
            }
          }
        }
      } catch (err) {
        throw new LlmTimeoutError(
          `LLM stream failed (${config.model}): ${err instanceof Error ? err.message : String(err)}`,
          { stage: req.stage ?? "generate", cause: err },
        );
      }
    },
  };
}
