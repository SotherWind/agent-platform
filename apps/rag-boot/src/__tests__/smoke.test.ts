// T0.1 接入 Vitest 测试基建
// 验收：pnpm --filter @agent-platform/rag-boot test 退出码 0 且真实执行用例
describe("测试基建", () => {
  it("能运行一个通过的断言", () => {
    expect(1 + 1).toBe(2);
  });

  it("能解析 TS path 与 ESM import", async () => {
    const { buildGraph } = await import("../agent");
    expect(typeof buildGraph).toBe("function");
  });
});
