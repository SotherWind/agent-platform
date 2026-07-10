import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVectorStore } from "./vectorstore";
import { createApiReranker } from "./rerank";
import type { RetrievedChunk, RerankedChunk } from "./type";

const TENANT_ID = "long-doc-eval";
const DOCUMENT_ID = "javascript-es6-style-guide";

/** 向量初筛召回数（模拟生产：先宽召回，再 Rerank） */
const VECTOR_POOL = 10;
/** Rerank 后参与评测的结果数 */
const RERANK_POOL = 5;
/** 评测 Recall@K 的 K 值 */
const EVAL_K = [3, 5, 10] as const;
/** 控制台展示的明细条数（默认与召回池一致，可改小） */
const DETAIL_TOP = VECTOR_POOL;
/** 每条 content 预览长度 */
const PREVIEW_LEN = 500;

interface TestCase {
  query: string;
  expectedSection: string;
  /** 单个 chunk 内需包含的片段（忽略空白差异） */
  mustContain?: string;
  /** 单个 chunk 内需同时包含的多个片段（适合代码块被切成多段时） */
  mustContainAll?: string[];
}

// const TEST_CASES: TestCase[] = [
//   { query: "一线城市出差住宿每晚最高多少钱", expectedSection: "差旅住宿费用标准", mustContain: "五百五十元" },
//   { query: "出差需要提前几天申请", expectedSection: "出差申请与审批流程", mustContain: "三个工作日" },
//   { query: "绩效考核S级奖金比例", expectedSection: "绩效管理与PIP制度", mustContain: "一百五十" },
//   { query: "数据库全量备份保留多少天", expectedSection: "数据备份与灾难恢复", mustContain: "三十天" },
//   { query: "VPN连接多久会超时", expectedSection: "VPN与远程接入规范", mustContain: "六小时" },
//   { query: "离职后账号数据保留多久删除", expectedSection: "账号权限与生命周期管理", mustContain: "四十五天" },
//   { query: "发票遗失单次最多报多少", expectedSection: "发票管理与税务合规", mustContain: "八百元" },
//   { query: "远程办公每周最多几天", expectedSection: "考勤与弹性办公办法", mustContain: "三天" },
//   { query: "网约车单次报销上限", expectedSection: "差旅交通与机票标准", mustContain: "六十元" },
//   { query: "采购超过五十万需要什么流程", expectedSection: "采购付款与供应商管理", mustContain: "招标" },
//   { query: "董事会定期会议一年至少几次", expectedSection: "董事会职权与会议制度", mustContain: "四次" },
//   { query: "员工学习账户每年多少额度", expectedSection: "培训发展与学习账户", mustContain: "三千元" },
//   { query: "高危漏洞须在多少小时内修复", expectedSection: "漏洞管理与渗透测试", mustContain: "七十二小时" },
//   { query: "销售新客户首年提成比例", expectedSection: "业绩核算与提成发放", mustContain: "百分之八" },
//   { query: "核心SaaS月度可用性目标是多少", expectedSection: "SLA与可用性目标", mustContain: "九十九点九" },
//   { query: "竞业限制补偿金是工资的百分之几", expectedSection: "离职与竞业限制管理", mustContain: "百分之三十" },
//   { query: "费用报销逾期多少天原则上不受理", expectedSection: "日常费用报销总则", mustContain: "六十天" },
//   { query: "P0级故障响应时间要求", expectedSection: "IT服务台与故障分级", mustContain: "十五分钟" },
//   { query: "线索超过几天无更新回收公海", expectedSection: "销售线索与商机管理", mustContain: "七天" },
//   { query: "代码合并测试覆盖率不低于多少", expectedSection: "代码质量与评审规范", mustContain: "百分之七十" },
// ];

const TEST_CASES: TestCase[] = [
  {
    query: "函数内部用 self 或 that 保存 this 给回调用",
    expectedSection: "命名规则",
    mustContain: "const self = this",
  },
];

const filePath = join(
  dirname(fileURLToPath(import.meta.url)),
  // "../knowledge/enterprise-manual-long.md",
  '../knowledge/javascript(ES6)语言编码规范.md',
);

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchesGold(
  chunk: RetrievedChunk,
  expectedSection: string,
  mustContain?: string,
  mustContainAll?: string[],
): boolean {
  if (chunk.metadata.section !== expectedSection) return false;
  const haystack = normalizeForMatch(chunk.content);
  const needles = [
    ...(mustContain ? [mustContain] : []),
    ...(mustContainAll ?? []),
  ];
  if (needles.length === 0) return true;
  return needles.every((n) => haystack.includes(normalizeForMatch(n)));
}

/** 返回金标 chunk 在结果列表中的名次（1-based），未命中返回 null */
function goldRank(
  results: RetrievedChunk[],
  expectedSection: string,
  mustContain?: string,
  mustContainAll?: string[],
): number | null {
  const idx = results.findIndex((r) =>
    matchesGold(r, expectedSection, mustContain, mustContainAll),
  );
  return idx === -1 ? null : idx + 1;
}

/** 仅匹配章节（不要求 mustContain），用于对比「章节级」召回 */
function sectionRank(
  results: RetrievedChunk[],
  expectedSection: string,
): number | null {
  const idx = results.findIndex(
    (r) => r.metadata.section === expectedSection,
  );
  return idx === -1 ? null : idx + 1;
}

function formatGoldLabel(tc: TestCase): string {
  const parts = [tc.expectedSection];
  if (tc.mustContain) parts.push(`含「${tc.mustContain}」`);
  if (tc.mustContainAll?.length) {
    parts.push(`含 ${tc.mustContainAll.map((s) => `「${s}」`).join(" + ")}`);
  }
  return parts.join("，");
}

function recallAtK(rank: number | null, k: number): number {
  return rank !== null && rank <= k ? 1 : 0;
}

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function formatRank(rank: number | null): string {
  return rank === null ? "未命中" : `#${rank}`;
}

function preview(text: string, max = PREVIEW_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function formatSectionLabel(meta: Record<string, unknown>): string {
  const section = String(meta.section ?? "未知章节");
  const chunk = meta.sectionChunk;
  const total = meta.sectionChunks;
  if (chunk && total) return `${section} (${chunk}/${total})`;
  return section;
}

function toVectorRow(
  r: RetrievedChunk,
  rank: number,
  tc: TestCase,
) {
  const isGold = matchesGold(
    r,
    tc.expectedSection,
    tc.mustContain,
    tc.mustContainAll,
  );
  return {
    rank,
    gold: isGold,
    score: Number(r.score.toFixed(4)),
    id: r.id,
    section: formatSectionLabel(r.metadata),
    documentId: r.documentId,
    preview: preview(r.content),
    content: r.content,
  };
}

function toRerankRow(r: RerankedChunk, rank: number, tc: TestCase) {
  const base = toVectorRow(r, rank, tc);
  return {
    ...base,
    vectorScore: base.score,
    rerankScore: Number(r.rerankScore.toFixed(4)),
    score: Number(r.rerankScore.toFixed(4)),
  };
}

function printVectorDetail(results: RetrievedChunk[], tc: TestCase) {
  const rows = results.slice(0, DETAIL_TOP).map((r, i) => toVectorRow(r, i + 1, tc));
  console.log(`\n【向量检索数据】${results.length} 条，展示 Top${Math.min(DETAIL_TOP, results.length)}`);
  for (const row of rows) {
    console.log(
      `${row.gold ? "✅" : "  "} #${row.rank}  score=${row.score}  ${row.section}`,
    );
    console.log(`    id: ${row.id}`);
    console.log(`    preview: ${row.preview}`);
  }
  console.log("\n【向量检索 JSON】");
  console.log(JSON.stringify(rows, null, 2));
}

function printRerankDetail(reranked: RerankedChunk[], tc: TestCase) {
  const rows = reranked.slice(0, DETAIL_TOP).map((r, i) => toRerankRow(r, i + 1, tc));
  console.log(`\n【Rerank 数据】${reranked.length} 条，展示 Top${Math.min(DETAIL_TOP, reranked.length)}`);
  for (const row of rows) {
    console.log(
      `${row.gold ? "✅" : "  "} #${row.rank}  rerank=${row.rerankScore}  vector=${row.vectorScore}  ${row.section}`,
    );
    console.log(`    id: ${row.id}`);
    console.log(`    preview: ${row.preview}`);
  }
  console.log("\n【Rerank JSON】");
  console.log(JSON.stringify(rows, null, 2));
}

const store = await createVectorStore();

const chunkCount = await store.ingestFile(filePath, {
  tenantId: TENANT_ID,
  documentId: DOCUMENT_ID,
  chunkSize: 500,
  chunkOverlap: 50,
});
console.log(
  `✅ 入库完成：${chunkCount} 个 chunk（${filePath.split(/[/\\]/).pop()}，章节内二次切分 chunkSize=500）\n`,
);
console.log(
  `评测配置：向量初筛 Top${VECTOR_POOL} → Rerank Top${RERANK_POOL} | Recall@${EVAL_K.join("/")} + MRR\n`,
);

const reranker = process.env.RERANK_API_KEY
  ? createApiReranker()
  : null;

const vectorRanks: Array<number | null> = [];
const vectorSectionRanks: Array<number | null> = [];
const rerankRanks: Array<number | null> = [];
const rerankSectionRanks: Array<number | null> = [];

for (const tc of TEST_CASES) {
  const { query, expectedSection, mustContain, mustContainAll } = tc;
  const vectorResults = await store.search(query, TENANT_ID, VECTOR_POOL);
  const vRank = goldRank(
    vectorResults,
    expectedSection,
    mustContain,
    mustContainAll,
  );
  const vSectionRank = sectionRank(vectorResults, expectedSection);
  vectorRanks.push(vRank);
  vectorSectionRanks.push(vSectionRank);

  console.log(`${"─".repeat(64)}`);
  console.log(`Q: ${query}`);
  console.log(`金标: ${formatGoldLabel(tc)}`);
  console.log(
    `【向量 @${VECTOR_POOL}】chunk ${formatRank(vRank)} | 章节 ${formatRank(vSectionRank)} | Top5: ${vectorResults
      .slice(0, 5)
      .map((r) => r.metadata.section)
      .join(" → ")}`,
  );
  printVectorDetail(vectorResults, tc);

  if (reranker) {
    try {
      const reranked = await reranker.rerank(
        query,
        vectorResults,
        RERANK_POOL,
      );
      const rRank = goldRank(
        reranked,
        expectedSection,
        mustContain,
        mustContainAll,
      );
      const rSectionRank = sectionRank(reranked, expectedSection);
      rerankRanks.push(rRank);
      rerankSectionRanks.push(rSectionRank);
      console.log(
        `【Rerank @${RERANK_POOL}】chunk ${formatRank(rRank)} | 章节 ${formatRank(rSectionRank)} | Top5: ${reranked
          .slice(0, 5)
          .map(
            (r) =>
              `${r.metadata.section}(${r.rerankScore?.toFixed(3) ?? "-"})`,
          )
          .join(" → ")}`,
      );
      printRerankDetail(reranked, tc);
    } catch (error) {
      rerankRanks.push(null);
      console.warn(
        "【Rerank 跳过】",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

function printMetrics(
  label: string,
  ranks: Array<number | null>,
  total: number,
) {
  const hitCount = ranks.filter((r) => r !== null).length;
  const recallLine = EVAL_K.map(
    (k) =>
      `R@${k}=${(
        (avg(ranks.map((r) => recallAtK(r, k))) * 100)
      ).toFixed(0)}%`,
  ).join("  ");
  const mrr = avg(ranks.map(reciprocalRank));
  const meanRank = avg(
    ranks.filter((r): r is number => r !== null).map((r) => r),
  );
  console.log(
    `【${label}】命中 ${hitCount}/${total}  ${recallLine}  MRR=${mrr.toFixed(3)}  平均名次=${hitCount ? meanRank.toFixed(1) : "-"}`,
  );
}

console.log(`\n${"═".repeat(64)}`);
console.log("指标说明：chunk = 章节+关键片段同块命中；章节 = 仅看 section 是否进 TopK");
printMetrics(`向量 chunk`, vectorRanks, TEST_CASES.length);
printMetrics(`向量 章节`, vectorSectionRanks, TEST_CASES.length);
if (reranker && rerankRanks.length > 0) {
  printMetrics(`Rerank chunk`, rerankRanks, TEST_CASES.length);
  printMetrics(`Rerank 章节`, rerankSectionRanks, TEST_CASES.length);
}
