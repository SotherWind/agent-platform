import { defineConfig } from "vitest/config";

/**
 * 两个 project：
 * - unit（默认）：全 fake，不碰网络 / .env / 本地 Qdrant，CI 必跑
 * - integration：需要进程外能力，CI 只在能力具备时跑
 *   - 目前承载 T0.4 的 SQLite checkpointer 用例（`__tests__/integration/`），
 *     依赖 better-sqlite3 原生模块：ABI 与 Node 版本绑定，装不上时用例内自检跳过。
 *   - 需要真实 LLM / Qdrant / Rerank 的用例将来也放这里，同样自带可用性守卫。
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
          // 嵌套 project 同样不继承顶层超时；integration 跑真实图，冷启动更重。
          testTimeout: 30_000,
          hookTimeout: 30_000,
          passWithNoTests: true,
        },
      },
    ],
  },
});
