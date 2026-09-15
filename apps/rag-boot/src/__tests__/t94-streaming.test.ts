/**
 * T9.4 流式输出——专属测试
 *
 * 实现策略是「先审后发」（index.ts stream()）：先完整执行图并完成
 * 输出 Guardrails / Reviewer，再把通过终审的 finalAnswer 按 chunk 发送。
 * 此前只有「chunk 拼接等于 finalAnswer」一条用例，清单规格的另外两条没有钉：
 * - 「流式过程中 Guardrails 拦截时能中断并替换为兜底话术」（清单 882 行）
 * - 「流式中断（客户端断开）时会话状态仍正确落盘」（清单 885 行）
 */
import { MemorySaver } from "@langchain/langgraph";
import { createGraph } from "../index";
import { admittedInput } from "./helpers/admitted-input";
import { createFakeLlm } from "../llm/fake";
import type { Llm, LlmRequest, LlmResponse } from "../llm/types";
import type { RetrievedChunk } from "../schema";

/** 按 stage → 调用序依次取用回复的 fake LLM（t33 同款） */
function createSequencedLlm(byStageSeq: Record<string, string[]>): Llm {
  const counts: Record<string, number> = {};
  const calls: Array<{ stage?: string }> = [];
  const invoke = async (req: LlmRequest): Promise<LlmResponse> => {
    const stage = req.stage ?? "";
    const seq = byStageSeq[stage] ?? ["{}"];
    const idx = Math.min(counts[stage] ?? 0, seq.length - 1);
    counts[stage] = (counts[stage] ?? 0) + 1;
    calls.push({ stage });
    return {
      text: seq[idx],
      model: "fake-seq",
      tier: "small",
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
    };
  };
  return {
    model: "fake-seq",
    tier: "small",
    calls,
    async invoke(req) {
      return invoke(req);
    },
  } as Llm;
}

const doc = (id: string): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId: "tenant-a",
  content: `知识片段 ${id}`,
  score: 0.9,
  metadata: {},
});

function vectorStoreReturning() {
  return {
    search: async () => [doc("c1")],
    addDocuments: async () => 1,
    ingestFile: async () => 1,
    deleteByDocumentId: async () => {},
  };
}

describe("T9.4 流式输出", () => {
  it("流式过程中 Guardrails 拦截时能中断并替换为兜底话术", async () => {
    // 生成节点产出了带虚假承诺的高风险答案，终审判不通过。
    // 先审后发：这类内容在图内就被拦截，发给用户的只能是升级话术，
    // 不存在「已发出才被拦回」的路径。
    const model = createSequencedLlm({
      triage: [
        JSON.stringify({
          categories: ["general"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: false,
        }),
      ],
      specialist: [JSON.stringify({ status: "resolved", answer: "本产品保证百分百满意！" })],
      generate: ["本产品保证百分百满意，绝对没有问题！"],
      review: [
        JSON.stringify({
          passed: false,
          violations: [{ code: "overpromise", detail: "虚假承诺表述" }],
        }),
      ],
    });
    const api = await createGraph({
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });

    const chunks: string[] = [];
    for await (const chunk of api.stream(
      admittedInput({
        query: "退款规则",
        tenantId: "tenant-a",
        authenticated: true,
        threadId: "t94-blocked",
        history: [],
      }),
      { configurable: { thread_id: "t94-blocked" } },
    )) {
      chunks.push(chunk);
    }

    const sent = chunks.join("");
    // 高风险内容一个字都不能到用户手里
    expect(sent).not.toContain("保证");
    expect(sent).not.toContain("百分百");
    expect(sent).not.toContain("绝对");
    // 终审不通过 → 带草稿进人工队列，用户收到的是明确的升级话术
    expect(sent).toContain("人工");
  });

  it("流式中断（客户端断开）时会话状态仍正确落盘", async () => {
    const saver = new MemorySaver();
    const model = createFakeLlm({
      byStage: {
        triage: JSON.stringify({
          categories: ["general"],
          urgency: "normal",
          likelyNeedsHuman: false,
          needsRealtimeData: false,
        }),
        specialist: JSON.stringify({ status: "resolved", answer: "已回答" }),
        generate: "这是通过终审的完整回答内容。",
        review: JSON.stringify({ passed: true, violations: [] }),
      },
    });
    // 走生产入口（index.ts stream()）而不是测试内替身：
    // 此前这条用例重造了一个"语义相同"的 stream 替身（注释自陈），
    // 等于清单第 2 条从未验证过生产代码。checkpointer 经
    // CreateGraphOptions（extends BuildGraphConfig）注入。
    const api = await createGraph({
      checkpointer: saver,
      vectorStore: vectorStoreReturning(),
      reranker: null,
      llms: { simple: model, small: model, large: model },
    });

    const gen = api.stream(
      admittedInput({
        query: "退款规则",
        tenantId: "tenant-a",
        authenticated: true,
        threadId: "t94-disconnect",
        history: [],
      }),
      { configurable: { thread_id: "t94-disconnect" } },
    );
    const first = await gen.next(); // 客户端收到第一个 chunk
    expect(first.value).toBeTruthy();
    await gen.return(undefined); // 客户端断开连接

    // 先审后发的关键收益：断开发生在 checkpoint 已落盘之后，会话状态完整
    const tuple = await saver.getTuple({ configurable: { thread_id: "t94-disconnect" } });
    expect(tuple).toBeDefined();
    const raw = JSON.stringify(tuple);
    expect(raw).toContain("finalAnswer");
    expect(raw).toContain("通过终审的完整回答");
  });
});
