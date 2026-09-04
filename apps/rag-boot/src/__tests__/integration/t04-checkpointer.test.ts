/**
 * T0.4 生产 checkpointer：进程重启后能恢复 checkpoint
 *
 * 三条验收（清单 T0.4）：
 *   1. 换 saver 实例、同一 sqlite 文件能读到上一轮的 query 与 citations
 *   2. 第二轮在恢复出来的状态上继续推进（turnCount 递增）
 *   3. 不同 threadId 互不可见
 *
 * 为什么必须放 integration 且用真文件：这三条要跑真实 better-sqlite3。
 * 用 MemorySaver 替身测不出 putWrites 的参数绑定错误——本文件存在的直接原因就是
 * sqlite-saver.ts 把 PendingWrite（[channel, value] 二元组）当三元组解构，
 * 只有真 SQLite 执行 INSERT 时才会暴露。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph } from "../../agent";
import { createFakeLlm } from "../../llm/fake";
import { SqliteSaver } from "../../sqlite-saver";
import type { RetrievedChunk } from "../../schema";

// better-sqlite3 是原生模块，ABI 与 node 版本绑定（编译用 24 / 运行用 22 就会挂）。
// 与 entry-idempotency.test.ts 保持同一套约定：装不上就跳过，不因此让套件变红。
const sqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const doc = (id: string, tenantId = "tenant-a"): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  tenantId,
  content: `知识片段 ${id}`,
  score: 0.9,
  metadata: {},
});

function build(saver: SqliteSaver) {
  const model = createFakeLlm({
    byStage: {
      triage: JSON.stringify({
        categories: ["general"],
        urgency: "normal",
        likelyNeedsHuman: false,
        needsRealtimeData: false,
      }),
      rewrite: "退款规则",
      specialist: JSON.stringify({
        status: "resolved",
        answer: "请参考知识库中的退款规则。",
        citations: ["c1"],
      }),
      generate: "基于知识库，这是可核对的回答。",
      review: JSON.stringify({ passed: true, violations: [] }),
    },
  });

  return buildGraph({
    checkpointer: saver,
    vectorStore: {
      search: async () => [doc("c1")],
      addDocuments: async () => 1,
      ingestFile: async () => 1,
      deleteByDocumentId: async () => {},
    },
    reranker: null,
    llms: { simple: model, small: model, large: model },
  });
}

describe("T0.4 生产 checkpointer（SQLite 落盘）", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-boot-ckpt-"));
    path = join(dir, "checkpoints.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("换 saver 实例、同一 sqlite 文件能读到上一轮的 query 与 citations", async () => {
    if (!sqliteAvailable) return;

    const first = new SqliteSaver({ path });
    const graph = await build(first);
    const config = { configurable: { thread_id: "thread-restart" } };
    await graph.invoke(
      { query: "第一轮问退款", tenantId: "tenant-a", threadId: "thread-restart", messages: [] },
      config,
    );
    first.close();

    // 全新实例 + 同一文件 = 模拟进程重启
    const second = new SqliteSaver({ path });
    const tuple = await second.getTuple(config);
    second.close();

    expect(tuple).toBeDefined();
    const values = tuple!.checkpoint.channel_values as Record<string, unknown>;
    expect(values.query).toBe("第一轮问退款");
    expect(values.citations).toEqual(
      expect.arrayContaining([expect.objectContaining({ chunkId: "c1" })]),
    );
  });

  it("重启后继续对话，turnCount 在恢复出来的状态上递增", async () => {
    if (!sqliteAvailable) return;

    const first = new SqliteSaver({ path });
    const firstGraph = await build(first);
    const config = { configurable: { thread_id: "thread-continue" } };
    const firstResult = await firstGraph.invoke(
      { query: "第一轮", tenantId: "tenant-a", threadId: "thread-continue", messages: [] },
      config,
    );
    first.close();

    const second = new SqliteSaver({ path });
    const secondGraph = await build(second);
    const secondResult = await secondGraph.invoke(
      { query: "第二轮", tenantId: "tenant-a", threadId: "thread-continue", messages: [] },
      config,
    );
    second.close();

    expect(secondResult.turnCount).toBeGreaterThan(firstResult.turnCount);
  });

  it("不同 threadId 互不可见", async () => {
    if (!sqliteAvailable) return;

    const saver = new SqliteSaver({ path });
    const graph = await build(saver);
    await graph.invoke(
      { query: "线程 A 的问题", tenantId: "tenant-a", threadId: "thread-a", messages: [] },
      { configurable: { thread_id: "thread-a" } },
    );

    const tuple = await saver.getTuple({ configurable: { thread_id: "thread-b" } });
    saver.close();

    expect(tuple).toBeUndefined();
  });
});
