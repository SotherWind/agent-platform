import assert from "node:assert/strict";
import { clearLLMCache, getLLM, getLLMCacheSize, LLMModelType, loadLLMConfig, removeLLMCache } from "./index";

const originalEnv = { ...process.env };

process.env = {
  ...originalEnv,
  MODEL_API_KEY: "test-key",
  MODEL_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
  MODEL_NAME: "glm-4.5",
  MODEL_MINI_API_KEY: "mini-test-key",
  MODEL_MINI_BASE_URL: "https://mini.example.com/v1",
  MODEL_MINI_NAME: "glm-4.5-air",
  MODEL_VISION_API_KEY: "vision-test-key",
  MODEL_VISION_BASE_URL: "https://vision.example.com/v1",
  MODEL_VISION_NAME: "glm-4v-plus",
};
clearLLMCache();

const config = loadLLMConfig();
assert.deepEqual(config.models.default, {
  apiKey: "test-key",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  model: "glm-4.5",
});
assert.deepEqual(config.models.mini, {
  apiKey: "mini-test-key",
  baseUrl: "https://mini.example.com/v1",
  model: "glm-4.5-air",
});
assert.deepEqual(config.models.vision, {
  apiKey: "vision-test-key",
  baseUrl: "https://vision.example.com/v1",
  model: "glm-4v-plus",
});

const defaultModel = getLLM({ temperature: 0 });
const sameDefault = getLLM(LLMModelType.Default, { temperature: 0 });
const defaultWithoutOptions = getLLM();
const mini = getLLM("mini", { temperature: 0 });
const sameMini = getLLM(LLMModelType.Mini, { temperature: 0 });
const vision = getLLM("vision", { temperature: 0 });
const uncached = getLLM({ temperature: 0, cache: false });
const configured = getLLM({
  model: "glm-4.5-air",
  apiKey: process.env.MODEL_MINI_API_KEY,
  configuration: {
    baseURL: "https://mini.example.com/v1",
  },
  maxRetries: 1,
});

assert.equal(defaultModel.raw, sameDefault.raw);
assert.equal(defaultModel.raw, defaultWithoutOptions.raw);
assert.equal(mini.raw, sameMini.raw);
assert.notEqual(defaultModel.raw, mini.raw);
assert.notEqual(mini.raw, vision.raw);
assert.notEqual(defaultModel.raw, uncached.raw);
assert.equal(mini.raw, configured.raw);
assert.equal(getLLMCacheSize(), 3);

defaultModel.raw.invoke = async (_input, options) => options as never;
const mergedOptions = await defaultModel.invoke("hello", { metadata: { source: "test" } });
assert.deepEqual(mergedOptions, {
  temperature: 0,
  metadata: {
    source: "test",
  },
});

assert.equal(removeLLMCache({
  model: "glm-4.5-air",
  apiKey: process.env.MODEL_MINI_API_KEY,
  baseUrl: "https://mini.example.com/v1",
}), true);
assert.equal(getLLMCacheSize(), 2);

const ttlModel = getLLM({
  model: "ttl-model",
  apiKey: process.env.MODEL_API_KEY,
  cacheTtlMs: 1,
});
assert.equal(getLLMCacheSize(), 3);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(getLLMCacheSize(), 2);
const refreshedTtlModel = getLLM({
  model: "ttl-model",
  apiKey: process.env.MODEL_API_KEY,
  cacheTtlMs: 1,
});
assert.notEqual(ttlModel.raw, refreshedTtlModel.raw);

clearLLMCache();
assert.equal(getLLMCacheSize(), 0);

process.env = originalEnv;

console.log("llm-sdk cache tests passed");
