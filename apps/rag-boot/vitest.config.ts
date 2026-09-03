import { defineConfig } from "vitest/config";

/**
 * 两个 project：
 * - unit（默认）：全 fake，不碰网络 / .env / 本地 Qdrant，CI 必跑
 * - integration：需要 .env 与真实服务（LLM / Qdrant / Rerank API），CI 默认跳过
 *
 * 注意 testTimeout：本包首次 import 会把 @langchain/qdrant 与 @langchain/openai 一起拉起，
 * 冷启动约 6s，超过 vitest 默认 5s 会让 smoke 用例假失败。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Windows CI 环境禁止 wmic；threads 不依赖该进程探测，且单元测试均为 CPU 轻量 fake。
    pool: "threads",
    passWithNoTests: true,
    coverage: { provider: "v8", clean: false },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/__tests__/**/*.test.ts"],
          exclude: ["src/__tests__/integration/**"],
          environment: "node",
          globals: true,
          // Vitest 4 的嵌套 project 不继承顶层 testTimeout，必须在这里重申，
          // 否则冷启动重导入用例（smoke/t8）会以默认 5s 假失败。
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/__tests__/integration/**/*.test.ts"],
          environment: "node",
          globals: true,
          // integration 需要 .env 与真实服务，CI 默认不跑（显式 --project integration）
          passWithNoTests: true,
        },
      },
    ],
  },
});
