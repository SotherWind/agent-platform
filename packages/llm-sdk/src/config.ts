import { LLMModelType, type EnvLike, type LLMConfig } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const DEFAULT_MODELS: Record<LLMModelType, string> = {
  [LLMModelType.Default]: "gpt-4o",
  [LLMModelType.Mini]: "gpt-4o-mini",
  [LLMModelType.Vision]: "gpt-4o",
};

export function loadLLMConfig(source: EnvLike = runtimeEnv()): LLMConfig {
  const defaultApiKey = readFirstString(source, ["MODEL_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY"]);
  const defaultBaseUrl =
    readFirstString(source, ["MODEL_BASE_URL", "LLM_BASE_URL", "OPENAI_BASE_URL"]) ?? DEFAULT_BASE_URL;
  assertUrl(defaultBaseUrl, "MODEL_BASE_URL");
  const miniBaseUrl =
    readFirstString(source, [
      "MODEL_MINI_BASE_URL",
      "MINI_MODEL_BASE_URL",
      "LLM_MINI_BASE_URL",
      "OPENAI_MINI_BASE_URL",
      "MODEL_SMALL_BASE_URL",
      "SMALL_MODEL_BASE_URL",
      "LLM_SMALL_BASE_URL",
      "OPENAI_SMALL_BASE_URL",
    ]) ?? defaultBaseUrl;
  assertUrl(miniBaseUrl, "MODEL_MINI_BASE_URL");
  const visionBaseUrl =
    readFirstString(source, [
      "MODEL_VISION_BASE_URL",
      "VISION_MODEL_BASE_URL",
      "LLM_VISION_BASE_URL",
      "OPENAI_VISION_BASE_URL",
      "MODEL_MULTIMODAL_BASE_URL",
      "MULTIMODAL_MODEL_BASE_URL",
      "LLM_MULTIMODAL_BASE_URL",
      "OPENAI_MULTIMODAL_BASE_URL",
    ]) ?? defaultBaseUrl;
  assertUrl(visionBaseUrl, "MODEL_VISION_BASE_URL");

  return {
    models: {
      [LLMModelType.Default]: {
        apiKey: defaultApiKey,
        baseUrl: defaultBaseUrl,
        model:
          readFirstString(source, ["MODEL_NAME", "MODEL", "LLM_MODEL", "OPENAI_MODEL"]) ??
          DEFAULT_MODELS.default,
      },
      [LLMModelType.Mini]: {
        apiKey:
          readFirstString(source, [
            "MODEL_MINI_API_KEY",
            "MINI_MODEL_API_KEY",
            "LLM_MINI_API_KEY",
            "OPENAI_MINI_API_KEY",
            "MODEL_SMALL_API_KEY",
            "SMALL_MODEL_API_KEY",
            "LLM_SMALL_API_KEY",
            "OPENAI_SMALL_API_KEY",
          ]) ?? defaultApiKey,
        baseUrl: miniBaseUrl,
        model:
          readFirstString(source, [
            "MODEL_MINI_NAME",
            "MODEL_MINI_MODEL",
            "MINI_MODEL_NAME",
            "LLM_MINI_MODEL",
            "OPENAI_MINI_MODEL",
            "MODEL_SMALL_NAME",
            "MODEL_SMALL_MODEL",
            "LLM_SMALL_MODEL",
            "OPENAI_SMALL_MODEL",
          ]) ?? DEFAULT_MODELS.mini,
      },
      [LLMModelType.Vision]: {
        apiKey:
          readFirstString(source, [
            "MODEL_VISION_API_KEY",
            "VISION_MODEL_API_KEY",
            "LLM_VISION_API_KEY",
            "OPENAI_VISION_API_KEY",
            "MODEL_MULTIMODAL_API_KEY",
            "MULTIMODAL_MODEL_API_KEY",
            "LLM_MULTIMODAL_API_KEY",
            "OPENAI_MULTIMODAL_API_KEY",
          ]) ?? defaultApiKey,
        baseUrl: visionBaseUrl,
        model:
          readFirstString(source, [
            "MODEL_VISION_NAME",
            "MODEL_VISION_MODEL",
            "VISION_MODEL_NAME",
            "LLM_VISION_MODEL",
            "OPENAI_VISION_MODEL",
            "MODEL_MULTIMODAL_NAME",
            "MODEL_MULTIMODAL_MODEL",
            "LLM_MULTIMODAL_MODEL",
            "OPENAI_MULTIMODAL_MODEL",
          ]) ?? DEFAULT_MODELS.vision,
      },
    },
  };
}

function readFirstString(source: EnvLike, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function assertUrl(value: string, name: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function runtimeEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};
}
