/**
 * T8.2 PII 与留存——第 2 条「超过留存期的会话数据可被清理任务删除」
 *
 * 此前 RetentionRunner 只接过 AuditLog：会话数据（LangGraph checkpoint）从未接进
 * 留存体系，T8.2 第 2 条的"会话数据"实际是空的。这组用例验证 SqliteSaver
 * 实现 RetentionTarget 后的真实行为（需要真 SQLite，放 integration）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph } from "../../agent";
import { createFakeLlm } from "../../llm/fake";
import { SqliteSaver } from "../../sqlite-saver";
import { RetentionRunner } from "../../observability/pii";

const sqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const DAY = 24 * 60 * 60 * 1000;

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
      search: async () => [
        {
          id: "c1",
          documentId: "doc-c1",
          tenantId: "tenant-a",
          content: "知识片段 c1",
          score: 0.9,
          metadata: {},
        },
      ],
      addDocuments: async () => 1,
      ingestFile: async () => 1,
      deleteByDocumentId: async () => {},
    },
    reranker: null,
    llms: { simple: model, small: model, large: model },
  });
}

describe("T8.2 会话数据留存清理", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-boot-retention-"));
    path = join(dir, "checkpoints.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("超过留存期的 checkpoint 可被清理，未过期的会话仍可恢复", async () => {
    if (!sqliteAvailable) return;

    let now = 1_000_000;
    const saver = new SqliteSaver({ path, clock: () => now });
    const graph = await build(saver);
    const config = { configurable: { thread_id: "thread-retention" } };

    await graph.invoke(
      { query: "第一轮", tenantId: "tenant-a", threadId: "thread-retention", messages: [] },
      config,
    );
    // 31 天后再来一轮：此时库里同时存在「31 天前」和「现在」两批 checkpoint
    now += 31 * DAY;
    await graph.invoke(
      { query: "第二轮", tenantId: "tenant-a", threadId: "thread-retention", messages: [] },
      config,
    );

    // 清理 30 天留存线之外的会话数据
    const removed = saver.purge(now - 30 * DAY);
    expect(removed).toBeGreaterThanOrEqual(1);

    // 最近的会话状态仍在，仍可恢复
    const tuple = await saver.getTuple(config);
    saver.close();
    expect(tuple).toBeDefined();
    expect((tuple!.checkpoint.channel_values as Record<string, unknown>).query).toBe("第二轮");
  });

  it("SqliteSaver 作为 RetentionTarget 接入 RetentionRunner（session TTL 生效）", async () => {
    if (!sqliteAvailable) return;

    let now = 2_000_000;
    const saver = new SqliteSaver({ path, clock: () => now });
    const graph = await build(saver);
    const config = { configurable: { thread_id: "thread-runner" } };
    await graph.invoke(
      { query: "唯一的会话", tenantId: "tenant-a", threadId: "thread-runner", messages: [] },
      config,
    );

    // 清理任务视角：注册 checkpoint-store，session TTL 10 天
    const runner = new RetentionRunner({ sessionTtlMs: 10 * DAY });
    runner.register(saver);
    now += 11 * DAY; // 超过留存期
    const report = await runner.run(now);

    expect(report).toHaveLength(1);
    expect(report[0].target).toBe("checkpoint-store");
    expect(report[0].removed).toBeGreaterThanOrEqual(1);
    expect(await saver.getTuple(config)).toBeUndefined();
    saver.close();
  });
});
