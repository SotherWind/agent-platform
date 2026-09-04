import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document } from "@langchain/core/documents";
import { createVectorStore } from "../src/vectorstore";
import { createApiReranker } from "../src/rerank";

const TENANT_ID = "chunk-eval";
const DOCUMENT_ID = "t-1";
const VECTOR_TOP_K = 20;
const RERANK_TOP_K = 5;

const QUERY =
  "减少温室气体排放的主要政策工具有哪些？它们是如何发挥作用的？";

const filePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../knowledge/t-1.txt",
);

function preview(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 方案3：test 层按空行分段，再交给 addDocuments（不经过 ingestFile 的字数切分） */
async function loadParagraphDocuments(path: string): Promise<Document[]> {
  const raw = await readFile(path, "utf-8");
  return raw
    .split(/\r?\n\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (pageContent, index) =>
        new Document({
          pageContent,
          metadata: { section: `段落 ${index + 1}` },
        }),
    );
}

const store = await createVectorStore();

const paragraphDocs = await loadParagraphDocuments(filePath);
const chunkCount = await store.addDocuments(paragraphDocs, {
  tenantId: TENANT_ID,
  documentId: DOCUMENT_ID,
  source: filePath,
});
console.log(
  `✅ 段落切分入库：${chunkCount} chunks（${paragraphDocs.length} 段）← ${filePath.split(/[/\\]/).pop()}\n`,
);

console.log(`Q: ${QUERY}\n`);

const vectorResults = await store.search(QUERY, TENANT_ID, VECTOR_TOP_K);

console.log(`【向量 Top${VECTOR_TOP_K}】`);
for (let i = 0; i < vectorResults.length; i++) {
  const r = vectorResults[i];
  const section = r.metadata.section ?? "-";
  console.log(
    `#${i + 1}  score=${r.score.toFixed(4)}  ${r.content.length}字  ${section}`,
  );
  console.log(`    ${preview(r.content)}\n`);
}

const reranker = process.env.RERANK_API_KEY ? createApiReranker() : null;
if (!reranker) {
  console.log("【Rerank 跳过】未配置 RERANK_API_KEY");
} else {
  try {
    const reranked = await reranker.rerank(QUERY, vectorResults, RERANK_TOP_K);
    console.log(`【Rerank Top${RERANK_TOP_K}】`);
    for (let i = 0; i < reranked.length; i++) {
      const r = reranked[i];
      const section = r.metadata.section ?? "-";
      console.log(
        `#${i + 1}  rerank=${r.rerankScore.toFixed(4)}  vector=${r.score.toFixed(4)}  ${r.content.length}字  ${section}`,
      );
      console.log(`    ${preview(r.content)}\n`);
    }
  } catch (error) {
    console.warn(
      "【Rerank 跳过】",
      error instanceof Error ? error.message : error,
    );
  }
}
