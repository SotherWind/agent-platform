/**
 * T8.3 知识库生命周期——专属测试
 *
 * 此前 t8.test.ts 只测了 isKnowledgeDocumentActive / knowledgeFilter 这条纯函数，
 * 清单规格的另外两条没有钉：
 * - 「按 documentId 替换时旧向量被清理（现有 replace 行为的回归测试）」（清单 797 行）
 * - 「知识变更留下审核记录」（清单 798 行）——实现是 VectorStore 的
 *   onKnowledgeChange 审计回调（create/replace/delete 三类动作），从未被断言过。
 *
 * 不连真实 Qdrant：VectorStore 构造器只依赖注入的 LangChain store + 审计 sink，
 * 用 fake LangChain store 直接实例化（private 构造器仅在编译期设防）。
 */
import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import { VectorStore } from "../vectorstore";
import type { KnowledgeChangeAuditEntry, VectorStoreType } from "../type";

/** fake LangChain Qdrant store：记录写入与删除的 filter */
function makeFakeLangchainStore() {
  const addedDocs: Document[] = [];
  const deletedFilters: unknown[] = [];
  return {
    addedDocs,
    deletedFilters,
    addDocuments: async (docs: Document[]) => {
      addedDocs.push(...docs);
      return docs.length;
    },
    delete: async (opts: { filter?: unknown }) => {
      deletedFilters.push(opts.filter);
    },
  };
}

/** 绕过 private 构造器与 Qdrant 连接，直接拿 VectorStore 实例 */
function makeStore(sink?: (entry: KnowledgeChangeAuditEntry) => void | Promise<void>): VectorStoreType {
  const Ctor = VectorStore as unknown as new (
    store: unknown,
    onKnowledgeChange?: (entry: KnowledgeChangeAuditEntry) => void | Promise<void>,
  ) => VectorStoreType;
  return new Ctor(makeFakeLangchainStore(), sink);
}

const doc = (text: string) => new Document({ pageContent: text, metadata: {} });

describe("T8.3 知识库生命周期", () => {
  it("replace 默认删除旧向量；replace:false 追加不删", async () => {
    const fake = makeFakeLangchainStore();
    const Ctor = VectorStore as unknown as new (
      store: unknown,
      onKnowledgeChange?: (entry: KnowledgeChangeAuditEntry) => void | Promise<void>,
    ) => VectorStoreType;
    const store = new Ctor(fake, undefined) as VectorStoreType;

    await store.addDocuments([doc("v1")], { tenantId: "t1", documentId: "doc-a" });
    // replace 默认开：实现统一「先删后写」——首写时删除 filter 匹配不到向量，是幂等 no-op
    expect(fake.deletedFilters).toHaveLength(1);

    await store.addDocuments([doc("v2")], { tenantId: "t1", documentId: "doc-a" });
    expect(fake.deletedFilters).toHaveLength(2); // 替换：同样先删后写
    const filter = fake.deletedFilters[1] as { must: Array<{ key: string; match: { value: string } }> };
    const must = filter.must;
    expect(must).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "metadata.tenantId", match: { value: "t1" } }),
        expect.objectContaining({ key: "metadata.documentId", match: { value: "doc-a" } }),
      ]),
    );
    // 旧向量删掉之后才写新内容
    expect(fake.addedDocs.map((d) => d.pageContent)).toEqual(["v1", "v2"]);

    await store.addDocuments([doc("extra")], {
      tenantId: "t1",
      documentId: "doc-a",
      replace: false,
    });
    expect(fake.deletedFilters).toHaveLength(2); // 追加模式：不再删除（计数不增）
  });

  it("知识变更留下审核记录（create / replace / delete 三类动作）", async () => {
    // T8.3#4（清单 798 行）：审核记录此前从未被断言
    const audit: KnowledgeChangeAuditEntry[] = [];
    const store = makeStore((entry) => {
      audit.push({ ...entry });
    });

    await store.addDocuments([doc("a1"), doc("a2")], {
      tenantId: "t1",
      documentId: "doc-x",
      version: 2,
      replace: false,
    });
    await store.addDocuments([doc("a1-v2")], {
      tenantId: "t1",
      documentId: "doc-x",
      version: 3,
    });
    await store.deleteByDocumentId("doc-x", "t1");

    expect(audit.map((e) => e.action)).toEqual(["create", "replace", "delete"]);
    expect(audit.every((e) => e.tenantId === "t1" && e.documentId === "doc-x")).toBe(true);
    expect(audit.every((e) => typeof e.at === "number")).toBe(true);
    // chunk 数与版本号进记录，过期知识排查能定位到具体变更
    expect(audit[0]?.chunkCount).toBe(2);
    expect(audit[1]?.version).toBe(3);
  });

  it("审计动作按真实存在性判定：首写 create、覆盖才记 replace", async () => {
    // 此前实现无条件记 "replace"，首次写入的审计动作是错的（语义反了）。
    // 修好后按 documentExists 判定；这里的 fake 带 client.count，模拟真实 Qdrant 的
    // 存在性查询（轻量 fake 无 client 时保守按"存在"处理，见上面的用例）。
    const audit: KnowledgeChangeAuditEntry[] = [];
    let storedChunks = 0;
    const fake = {
      addedDocs: [] as Document[],
      deletedFilters: [] as unknown[],
      addDocuments: async (docs: Document[]) => {
        storedChunks += docs.length;
        return docs.length;
      },
      delete: async (opts: { filter?: unknown }) => {
        fake.deletedFilters.push(opts.filter);
        storedChunks = 0;
      },
      client: { count: async () => ({ count: storedChunks }) },
      collectionName: "test-collection",
    };
    const Ctor = VectorStore as unknown as new (
      store: unknown,
      onKnowledgeChange?: (entry: KnowledgeChangeAuditEntry) => void | Promise<void>,
    ) => VectorStoreType;
    const store = new Ctor(fake, (entry) => {
      audit.push({ ...entry });
    });

    await store.addDocuments([doc("v1")], { tenantId: "t1", documentId: "doc-new" });
    await store.addDocuments([doc("v2")], { tenantId: "t1", documentId: "doc-new" });

    expect(audit.map((e) => e.action)).toEqual(["create", "replace"]);
  });

  it("replace 替换后旧向量不残留（端到端语义：同 id 检索只出新内容）", async () => {
    // 用可查询的 fake store 模拟「按 documentId 定位删除」的净效果
    const rows: Array<{ id: string; documentId: string; tenantId: string; text: string }> = [];
    const fake = {
      addDocuments: async (docs: Document[]) => {
        for (const d of docs) {
          rows.push({
            id: String(d.metadata.id),
            documentId: String(d.metadata.documentId),
            tenantId: String(d.metadata.tenantId),
            text: d.pageContent,
          });
        }
        return docs.length;
      },
      delete: async (opts: { filter?: { must: Array<{ key: string; match: { value: string } }> } }) => {
        const get = (key: string) =>
          opts.filter?.must.find((m) => m.key === key)?.match.value;
        const documentId = get("metadata.documentId");
        const tenantId = get("metadata.tenantId");
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.documentId === documentId && rows[i]!.tenantId === tenantId) rows.splice(i, 1);
        }
      },
    };
    const Ctor = VectorStore as unknown as new (
      store: unknown,
      onKnowledgeChange?: (entry: KnowledgeChangeAuditEntry) => void | Promise<void>,
    ) => VectorStoreType;
    const store = new Ctor(fake, undefined) as VectorStoreType;

    await store.addDocuments([doc("过期价格：100 元")], { tenantId: "t1", documentId: "doc-price" });
    expect(rows).toHaveLength(1);

    await store.addDocuments([doc("最新价格：200 元")], { tenantId: "t1", documentId: "doc-price" });
    // 客服答错的主要代价来自过期知识——替换后旧行必须消失，只留新内容
    expect(rows.map((r) => r.text)).toEqual(["最新价格：200 元"]);
  });
});
