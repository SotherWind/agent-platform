/**
 * 环境变量加载（必须在所有其他 import 之前执行）。
 *
 * 双源策略（避免"配两遍"）：
 * 1. server/rag-bot/.env —— 优先，服务专属配置（PORT/账号表等）+ 可选的模型配置
 * 2. apps/rag-boot/.env —— 兜底补缺：已在该文件配置过模型 key 的，直接复用，
 *    不用在 server 里再填一遍；dotenv 默认不覆盖已存在的变量，优先级安全。
 *
 * Shell 环境变量 > server/.env > rag-boot/.env
 *
 * 占位符防遮挡：从 .env.example 复制后未改的占位值（your-api-key-here 等）
 * 会被视为"未设置"并从进程环境中剔除——避免占位符抢在真实配置之前占住变量名，
 * 导致另一份文件里的真实 key 永远补不进来。
 */
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const serverEnvPath = `${here}../.env`;
const libEnvPath = fileURLToPath(new URL("../../../apps/rag-boot/.env", import.meta.url));

/** .env.example 模板里的占位值；命中的变量视为未配置 */
const PLACEHOLDER_VALUES = new Set([
  "your-api-key-here",
  "your-rerank-api-key-here",
  "your-embedding-api-key-here",
  "your-model-name",
  "https://api.example.com/v1",
]);

function stripPlaceholders(): void {
  for (const key of Object.keys(process.env)) {
    if (PLACEHOLDER_VALUES.has(process.env[key] as string)) {
      delete process.env[key];
    }
  }
}

dotenv.config({ path: serverEnvPath });
stripPlaceholders();
dotenv.config({ path: libEnvPath });
stripPlaceholders();
