import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { loadLLMConfig } from "./config.js";
import {
  LLMModelType,
  type CachedLLM,
  type GetLLMOptions,
  type LLMDefaultCallOptions,
  type LLMInstance,
  type RemoveLLMCacheOptions,
} from "./types.js";

interface LLMCacheEntry {
  llm: LLMInstance;
  expiresAt?: number;
}

const llmCache = new Map<string, LLMCacheEntry>();

export function getLLM(options?: GetLLMOptions): CachedLLM;
export function getLLM(type: LLMModelType, options?: GetLLMOptions): CachedLLM;
export function getLLM(
  typeOrOptions: LLMModelType | GetLLMOptions = LLMModelType.Default,
  options: GetLLMOptions = {},
): CachedLLM {
  const type = typeof typeOrOptions === "string" ? typeOrOptions : LLMModelType.Default;
  const resolvedOptions = typeof typeOrOptions === "string" ? options : typeOrOptions;
  const { actualModel, apiKey, baseUrl } = resolveConnection(type, resolvedOptions);

  const { connectionOptions, defaultCallOptions } = splitLLMOptions(resolvedOptions);
  const cacheKey = createCacheKey(baseUrl, actualModel, apiKey);
  let llm: LLMInstance | undefined;

  if (resolvedOptions.cache !== false) {
    const cached = llmCache.get(cacheKey);
    if (cached && isExpired(cached)) {
      llmCache.delete(cacheKey);
    } else {
      llm = cached?.llm;
    }
  }

  if (!llm) {
    llm = new ChatOpenAI({
      ...connectionOptions,
      model: actualModel,
      apiKey,
      configuration: {
        ...connectionOptions.configuration,
        baseURL: baseUrl,
      },
    });

    if (resolvedOptions.cache !== false) {
      llmCache.set(cacheKey, {
        llm,
        expiresAt: resolveExpiresAt(resolvedOptions.cacheTtlMs),
      });
    }
  }

  return withDefaultCallOptions(llm, defaultCallOptions);
}

export function clearLLMCache(): void {
  llmCache.clear();
}

export function getLLMCacheSize(): number {
  pruneExpiredCache();
  return llmCache.size;
}

export function removeLLMCache(options: RemoveLLMCacheOptions = {}): boolean {
  const { actualModel, apiKey, baseUrl } = resolveConnection(LLMModelType.Default, options);
  return llmCache.delete(createCacheKey(baseUrl, actualModel, apiKey));
}

function resolveConnection(type: LLMModelType, options: RemoveLLMCacheOptions): {
  actualModel: string;
  apiKey: GetLLMOptions["apiKey"];
  baseUrl: string;
} {
  const config = loadLLMConfig();
  const modelConfig = config.models[type];
  const actualModel = options.model ?? modelConfig.model;
  const apiKey = options.apiKey ?? modelConfig.apiKey;
  const baseUrl = options.baseUrl ?? options.configuration?.baseURL ?? modelConfig.baseUrl;

  if (!apiKey) {
    throw new Error("Missing MODEL_API_KEY");
  }

  return {
    actualModel,
    apiKey,
    baseUrl,
  };
}

function resolveExpiresAt(cacheTtlMs: number | undefined): number | undefined {
  if (cacheTtlMs === undefined) {
    return undefined;
  }

  if (cacheTtlMs <= 0) {
    return Date.now();
  }

  return Date.now() + cacheTtlMs;
}

function isExpired(entry: LLMCacheEntry): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
}

function pruneExpiredCache(): void {
  for (const [key, entry] of llmCache) {
    if (isExpired(entry)) {
      llmCache.delete(key);
    }
  }
}

function createCacheKey(
  baseUrl: string,
  model: string,
  apiKey: GetLLMOptions["apiKey"],
): string {
  return stableStringify({
    baseUrl,
    model,
    apiKey: typeof apiKey === "string" ? hashString(apiKey) : toSerializable(apiKey),
  });
}

function splitLLMOptions(options: GetLLMOptions): {
  connectionOptions: ChatOpenAIFields;
  defaultCallOptions: LLMDefaultCallOptions;
} {
  const {
    model: _model,
    apiKey: _apiKey,
    baseUrl: _baseUrl,
    cache: _cache,
    cacheTtlMs: _cacheTtlMs,
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
    n,
    logitBias,
    stop,
    stopSequences,
    user,
    logprobs,
    topLogprobs,
    tools,
    tool_choice,
    response_format,
    seed,
    stream_options,
    parallel_tool_calls,
    strict,
    modalities,
    audio,
    prediction,
    reasoning,
    reasoningEffort,
    service_tier,
    promptCacheKey,
    promptCacheRetention,
    verbosity,
    ...connectionOptions
  } = options;

  return {
    connectionOptions,
    defaultCallOptions: removeUndefined({
      temperature,
      maxTokens,
      topP,
      frequencyPenalty,
      presencePenalty,
      n,
      logitBias,
      stop: stop ?? stopSequences,
      user,
      logprobs,
      topLogprobs,
      tools,
      tool_choice,
      response_format,
      seed,
      stream_options,
      parallel_tool_calls,
      strict,
      modalities,
      audio,
      prediction,
      reasoning,
      reasoningEffort,
      service_tier,
      promptCacheKey,
      promptCacheRetention,
      verbosity,
    }),
  };
}

function withDefaultCallOptions(llm: LLMInstance, defaultCallOptions: LLMDefaultCallOptions): CachedLLM {
  if (Object.keys(defaultCallOptions).length === 0) {
    return Object.assign(llm, {
      raw: llm,
      defaultCallOptions,
    });
  }

  const proxy = Object.create(llm) as CachedLLM;
  Object.defineProperties(proxy, {
    raw: {
      value: llm,
      enumerable: true,
    },
    defaultCallOptions: {
      value: defaultCallOptions,
      enumerable: true,
    },
    invoke: {
      value: (input: Parameters<LLMInstance["invoke"]>[0], options?: Parameters<LLMInstance["invoke"]>[1]) =>
        llm.invoke(input, mergeCallOptions(defaultCallOptions, options)),
    },
    stream: {
      value: (input: Parameters<LLMInstance["stream"]>[0], options?: Parameters<LLMInstance["stream"]>[1]) =>
        llm.stream(input, mergeCallOptions(defaultCallOptions, options)),
    },
    batch: {
      value: (
        inputs: Parameters<LLMInstance["batch"]>[0],
        options?: Parameters<LLMInstance["batch"]>[1],
        batchOptions?: Parameters<LLMInstance["batch"]>[2],
      ) => {
        if (Array.isArray(options)) {
          return llm.batch(
            inputs,
            options.map((item) => mergeCallOptions(defaultCallOptions, item)),
            batchOptions,
          );
        }
        return llm.batch(inputs, mergeCallOptions(defaultCallOptions, options), batchOptions);
      },
    },
  });

  return proxy;
}

function mergeCallOptions<T extends object | undefined>(
  defaultCallOptions: LLMDefaultCallOptions,
  options: T,
): T & LLMDefaultCallOptions {
  return {
    ...defaultCallOptions,
    ...(options ?? {}),
  } as T & LLMDefaultCallOptions;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

type Serializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Serializable[]
  | { [key: string]: Serializable };

function stableStringify(value: Serializable): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function toSerializable(value: unknown): Serializable {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item));
  }

  if (typeof value === "object") {
    const result: Record<string, Serializable> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined && typeof item !== "function") {
        result[key] = toSerializable(item);
      }
    }
    return result;
  }

  return String(value);
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}
