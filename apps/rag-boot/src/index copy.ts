import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "./agent";
import { createVectorStore } from "./vectorstore";
import { createApiReranker } from "./rerank";
import type { Reranker, State } from "./type";

config();

const knowledgeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../knowledge",
);

const TENANT_FINANCE = "tenant-finance";
const TENANT_HR = "tenant-hr";
const TENANT_EMPTY = "tenant-empty";

/**
 * 多租户隔离验证：固定同一问题，仅切换 tenantId，
 * 两租户应各自命中本租户知识库、返回不同内容。
 */
const SHARED_QUERY = "审批流程是怎样的？需要哪些人签字？";
/** 空租户 / 无命中场景 */
const EMPTY_QUERY = "量子纠缠的数学原理是什么？";

function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function createPassthroughReranker(): Reranker {
  return {
    async rerank(_query, chunks, topN) {
      return chunks.slice(0, topN).map((chunk) => ({
        ...chunk,
        rerankScore: chunk.score,
      }));
    },
  };
}

function resolveReranker(): Reranker {
  if (process.env.RERANK_API_KEY) {
    return createApiReranker();
  }
  console.warn("⚠ 未配置 RERANK_API_KEY，rerank 将退化为向量分排序\n");
  return createPassthroughReranker();
}

function printSection(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(title);
  console.log("=".repeat(60));
}

function printDocs(label: string, docs: State["retrievedDocs"] | State["rerankedDocs"]) {
  if (docs.length === 0) {
    console.log(`  （无）`);
    return;
  }
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const score =
      "rerankScore" in doc
        ? `rerank=${doc.rerankScore.toFixed(4)} vector=${doc.score.toFixed(4)}`
        : `vector=${doc.score.toFixed(4)}`;
    console.log(
      `  #${i + 1} [${doc.tenantId}] ${score} ${doc.metadata.section ?? "-"}`,
    );
    console.log(`      ${preview(doc.content)}`);
  }
}

async function expectError(
  label: string,
  fn: () => Promise<unknown>,
  expectedMessage: string,
) {
  try {
    await fn();
    console.log(`❌ ${label}：预期抛出错误，但正常返回了`);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) {
      console.log(`✅ ${label}：按预期抛出错误`);
      console.log(`   → ${message}`);
      return true;
    }
    console.log(`❌ ${label}：抛出了错误，但消息不符合预期`);
    console.log(`   期望包含: ${expectedMessage}`);
    console.log(`   实际: ${message}`);
    return false;
  }
}

async function main() {
  console.log("=== RAG Boot 验证 ===");

  const store = await createVectorStore();
  const reranker = resolveReranker();

  const financeChunks = await store.ingestFile(
    join(knowledgeDir, "finance-policy.md"),
    { tenantId: TENANT_FINANCE, documentId: "finance-policy" },
  );
  const hrChunks = await store.ingestFile(join(knowledgeDir, "hr-policy.md"), {
    tenantId: TENANT_HR,
    documentId: "hr-policy",
  });
  console.log(
    `\n📚 入库完成：finance ${financeChunks} chunks | hr ${hrChunks} chunks | ${TENANT_EMPTY} 无数据`,
  );

  const graph = await buildGraph({ vectorStore: store, reranker });

  // ── 1. 知识库检索 + 2. Rerank 精排 ──────────────────────────
  printSection("【1+2】知识库检索 & Rerank 精排（tenant-finance）");
  const financeQuery = "差旅住宿标准是多少？";
  console.log(`Q: ${financeQuery}\n`);

  const financeResult = await graph.invoke({
    tenantId: TENANT_FINANCE,
    query: financeQuery,
  });

  console.log("── 向量检索 Top5（retrieve 节点）──");
  printDocs("retrieved", financeResult.retrievedDocs);

  console.log("\n── Rerank 精排 Top5（rerank 节点）──");
  printDocs("reranked", financeResult.rerankedDocs);

  const vectorOrder = financeResult.retrievedDocs.map((d) => d.id).join(",");
  const rerankOrder = financeResult.rerankedDocs.map((d) => d.id).join(",");
  if (financeResult.rerankedDocs.length > 0) {
    const topReranked = financeResult.rerankedDocs[0];
    const travelHit = topReranked.content.includes("差旅住宿标准");
    console.log(
      travelHit
        ? "\n✅ Rerank 首位命中「差旅标准」相关 chunk"
        : "\n⚠ Rerank 首位未命中「差旅标准」，请检查 rerank 配置",
    );
    if (vectorOrder !== rerankOrder && process.env.RERANK_API_KEY) {
      console.log("✅ Rerank 改变了排序（向量序 ≠ 精排序）");
    } else if (vectorOrder === rerankOrder && process.env.RERANK_API_KEY) {
      console.log("ℹ Rerank 后排序与向量序相同（本 query 下可能正常）");
    }
  }

  // ── 3. 多租户隔离：同一问题 + 不同 tenantId → 不同结果 ─────
  printSection("【3】多租户隔离（同一问题，不同租户，不同结果）");
  console.log(`固定问题（两租户完全相同）: ${SHARED_QUERY}\n`);

  const [resultFinance, resultHr] = await Promise.all([
    graph.invoke({ tenantId: TENANT_FINANCE, query: SHARED_QUERY }),
    graph.invoke({ tenantId: TENANT_HR, query: SHARED_QUERY }),
  ]);

  const financeTop = resultFinance.rerankedDocs[0];
  const hrTop = resultHr.rerankedDocs[0];

  console.log("┌─────────────────────┬──────────────────────────────────────────");
  console.log("│ 维度                │ 对比结果");
  console.log("├─────────────────────┼──────────────────────────────────────────");
  console.log(`│ tenantId            │ ${TENANT_FINANCE.padEnd(20)} │ ${TENANT_HR}`);
  console.log(
    `│ Top1 章节           │ ${String(financeTop?.metadata.section ?? "-").padEnd(20)} │ ${String(hrTop?.metadata.section ?? "-")}`,
  );
  console.log(
    `│ Top1 documentId     │ ${String(financeTop?.documentId ?? "-").padEnd(20)} │ ${String(hrTop?.documentId ?? "-")}`,
  );
  console.log("└─────────────────────┴──────────────────────────────────────────\n");

  console.log(`── ${TENANT_FINANCE} 检索结果 ──`);
  printDocs("finance", resultFinance.rerankedDocs);
  console.log(`\n── ${TENANT_HR} 检索结果 ──`);
  printDocs("hr", resultHr.rerankedDocs);

  const financeTenantsOk = resultFinance.rerankedDocs.every(
    (d) => d.tenantId === TENANT_FINANCE,
  );
  const hrTenantsOk = resultHr.rerankedDocs.every(
    (d) => d.tenantId === TENANT_HR,
  );
  const differentTopSection =
    financeTop?.metadata.section !== hrTop?.metadata.section;
  const differentTopContent = financeTop?.content !== hrTop?.content;
  const differentDocument =
    financeTop?.documentId !== hrTop?.documentId;

  if (
    resultFinance.rerankedDocs.length > 0 &&
    resultHr.rerankedDocs.length > 0 &&
    financeTenantsOk &&
    hrTenantsOk &&
    differentTopSection &&
    differentTopContent &&
    differentDocument
  ) {
    console.log(
      "\n✅ 多租户隔离成立：同一问题下，不同 tenantId 各自命中本租户文档，Top1 章节与内容均不同",
    );
    console.log(`   财务 Top1 → ${financeTop!.metadata.section}（${financeTop!.documentId}）`);
    console.log(`   HR   Top1 → ${hrTop!.metadata.section}（${hrTop!.documentId}）`);
  } else {
    console.log("\n❌ 多租户隔离未通过：");
    if (!financeTenantsOk || !hrTenantsOk) {
      console.log("   - 检索结果存在跨租户泄漏");
    }
    if (!differentTopSection || !differentTopContent || !differentDocument) {
      console.log("   - 两租户 Top1 结果相同，未能体现隔离");
    }
  }

  // ── 4. 无检索结果 ───────────────────────────────────────────
  printSection("【4】无检索结果（空租户 + 无关问题）");
  console.log(`tenantId: ${TENANT_EMPTY}`);
  console.log(`Q: ${EMPTY_QUERY}\n`);

  const emptyResult = await graph.invoke({
    tenantId: TENANT_EMPTY,
    query: EMPTY_QUERY,
  });

  if (
    emptyResult.retrievedDocs.length === 0 &&
    emptyResult.finalAnswer.includes("当前租户下无可用数据")
  ) {
    console.log("✅ 无数据租户：检索为空，返回友好提示（未抛错）");
    console.log(`   → ${emptyResult.finalAnswer}`);
  } else {
    console.log("❌ 无数据租户：行为不符合预期");
    console.log(`   retrievedDocs: ${emptyResult.retrievedDocs.length}`);
    console.log(`   finalAnswer: ${emptyResult.finalAnswer}`);
  }

  // ── 5. tenantId 为空 → Fail-closed 直接拒绝 ─────────────────
  printSection("【5】tenantId 为空 → Fail-closed 直接抛错");
  await expectError(
    "空 tenantId",
    () => graph.invoke({ tenantId: "", query: "测试问题" }),
    "tenantId is required",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
