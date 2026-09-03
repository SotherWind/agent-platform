// T0.3 领域类型与错误模型
import { LlmFallbackChain } from "../llm/degradation";
import { createFakeLlm } from "../llm/fake";
import {
  AgentError,
  TenantMissingError,
  GuardrailBlockedError,
  ToolExecutionError,
  LlmTimeoutError,
  BudgetExceededError,
  EscalationRequiredError,
  LlmConfigError,
} from "../errors";

describe("AgentError", () => {
  it("区分可重试与不可重试错误", () => {
    expect(new TenantMissingError().retryable).toBe(false);
    expect(new LlmTimeoutError().retryable).toBe(true);
  });

  it("携带 traceId 与 stage，便于 tracing 归因", () => {
    const err = new LlmTimeoutError("LLM invoke timeout", {
      traceId: "trace-123",
      stage: "generate",
    });
    expect(err.traceId).toBe("trace-123");
    expect(err.stage).toBe("generate");
    expect(err.name).toBe("LlmTimeoutError");
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(Error);
  });

  it("每个错误类型都有正确的 retryable 与默认 stage", () => {
    const cases: Array<[AgentError, boolean, string]> = [
      [new TenantMissingError(), false, "triage"],
      [new GuardrailBlockedError("blocked"), false, "guardrails"],
      [new ToolExecutionError("boom"), true, "tools"],
      [new LlmTimeoutError("timeout"), true, "generate"],
      [new BudgetExceededError("over budget"), false, "orchestrate"],
      [new EscalationRequiredError("needs human"), false, "escalate"],
      [new LlmConfigError("missing api key"), false, "generate"],
    ];
    for (const [err, retryable, stage] of cases) {
      expect(err.retryable).toBe(retryable);
      expect(err.stage).toBe(stage);
    }
  });

  it("降级链只对可重试错误切换模型", async () => {
    const first = createFakeLlm({ failWith: new LlmTimeoutError("timeout"), model: "primary" });
    const backup = createFakeLlm({ reply: "备用回答", model: "backup" });
    const chain = new LlmFallbackChain([first, backup]);
    await expect(chain.invoke({ prompt: "q", stage: "generate" })).resolves.toMatchObject({ model: "backup", degraded: true });

    const exhausted = new LlmFallbackChain([
      createFakeLlm({ failWith: new LlmTimeoutError("one"), model: "one" }),
      createFakeLlm({ failWith: new LlmTimeoutError("two"), model: "two" }),
    ]);
    await expect(exhausted.invoke({ prompt: "q", stage: "generate" })).resolves.toMatchObject({
      fallbackExhausted: true,
      model: "fixed-fallback",
    });

    const blocked = createFakeLlm({ failWith: new GuardrailBlockedError("blocked"), model: "blocked" });
    const never = createFakeLlm({ reply: "must not call", model: "never" });
    const blockedChain = new LlmFallbackChain([blocked, never]);
    await expect(blockedChain.invoke({ prompt: "q", stage: "generate" })).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(never.calls).toHaveLength(0);
  });

  it("保留 cause 链，便于排障", () => {
    const cause = new Error("ECONNRESET");
    const err = new LlmTimeoutError("wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});
