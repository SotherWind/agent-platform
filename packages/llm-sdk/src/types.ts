import type { ChatOpenAI, ChatOpenAICallOptions, ChatOpenAIFields } from "@langchain/openai";

export const LLMModelType = {
  Default: "default",
  Mini: "mini",
  Vision: "vision",
} as const;

export type LLMModelType = (typeof LLMModelType)[keyof typeof LLMModelType];

export type LLMInstance = ChatOpenAI;
export type LLMDefaultCallOptions = Partial<ChatOpenAICallOptions>;

export type CachedLLM = ChatOpenAI & {
  readonly raw: ChatOpenAI;
  readonly defaultCallOptions: LLMDefaultCallOptions;
};

export type EnvLike = Record<string, string | undefined>;

export interface LLMConnectionConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface LLMConfig {
  models: Record<LLMModelType, LLMConnectionConfig>;
}

export interface GetLLMOptions extends ChatOpenAIFields, Partial<ChatOpenAICallOptions> {
  baseUrl?: string;
  cache?: boolean;
  cacheTtlMs?: number;
}

export interface RemoveLLMCacheOptions extends Pick<GetLLMOptions, "model" | "apiKey" | "baseUrl" | "configuration"> {}
