/**
 * 供应商兼容性核验：把"能不能换供应商"从"看文档猜"变成"跑一次就知道"。
 *
 * 换 embedding / rerank 供应商时，代码层面几乎什么都不用改（全走 env），
 * 但有三件事会**静默出错**，必须实测：
 *
 * 1. **rerank 的分数尺度**。现役所有阈值（`floor=0.35`、`solid=0.55`）以及全部
 *    profile 都标定在 **sigmoid 归一化后的 [0,1]** 尺度上。若新供应商返回的是
 *    **原始 logit**（可以到 ±10），阈值不会报错，只会悄悄全部失效——
 *    正是 `docs/confidence-calibration.md` 反复警告的那种失效。
 * 2. **embedding 维度**。换模型必然换向量空间，必须重建 collection；
 *    维度不同而 collection 没重建时，Qdrant 会报维度错（这个还算会报错）。
 * 3. **模型名写法**。硅基流动要 `BAAI/bge-reranker-v2-m3`，模力方舟**不带前缀**
 *    （直接 `bge-reranker-v2-m3`）。写错只会得到一个"模型不存在"。
 *
 * 跑法（cwd = apps/rag-boot）：
 *   pnpm verify:provider
 *
 * 退出码非 0 表示当前配置不可直接用（尺度可疑 / 维度与 collection 不符 / 调用失败）。
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

/**
 * 只在**真的终端**上发 ANSI 颜色码。
 *
 * 这不是洁癖：实测在 Windows 上把带 ESC 的输出重定向进管道/文件时，
 * 下游会因为开头那段控制字节而把整流的编码判成系统代码页（cp936），
 * 中文全部变成 `褰撳墠閰嶇疆` 这种乱码——诊断工具的输出被弄坏是最糟的情况。
 * 管道场景一律发纯文本。
 */
const useColor = process.stdout.isTTY === true;
const wrap = (code: string) => (useColor ? code : "");
const RED = wrap("\u001b[31m");
const GREEN = wrap("\u001b[32m");
const YELLOW = wrap("\u001b[33m");
const DIM = wrap("\u001b[2m");
const RESET = wrap("\u001b[0m");

const mask = (key: string | undefined): string =>
  !key ? "(未设置)" : key.length <= 12 ? "***" : `${key.slice(0, 8)}…${key.slice(-4)}`;

/**
 * 核验用的一对文本：一个明显相关、一个明显不相关。
 *
 * 用同一对文本在**硅基流动**上的实测值作参照（2026-09-15，BAAI/bge-reranker-v2-m3，
 * 按生产"文首标题块 + 章节正文"的组织方式）：
 *   相关 → 0.97 量级；不相关 → 0.00 量级。
 * 换供应商后应当看到**同量级**的数；看到 −5 / +8 这种就是 logit，尺度不可迁移。
 */
const PROBE = {
  query: "七天无理由退货的运费谁承担？",
  relevant: "退货政策 · 七天无理由退货\n## 七天无理由退货\n签收后 7 天内，商品不影响二次销售的，可申请无理由退货。无理由退货的运费由买家承担。",
  irrelevant: "物流配送 · 物流查询\n## 物流查询\n可在「我的订单」→ 订单详情 查看物流轨迹，承运商为顺丰。",
};
const REFERENCE = { relevant: 0.97, irrelevant: 0.0 };

interface RerankProbe {
  ok: boolean;
  scores: number[];
  fieldUsed: string;
  detail: string;
}

/**
 * 打一次 /rerank，并**同时**尝试两种常见响应字段：
 * Cohere 风格是 `relevance_score`，少数实现给 `score`。
 * 顺带判定分数落在了哪个尺度上。
 */
async function probeRerank(baseUrl: string, apiKey: string, model: string): Promise<RerankProbe> {
  const url = `${baseUrl.replace(/\/$/, "")}/rerank`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // 模力方舟的可选容灾头；其他供应商忽略未知头
        "X-Failover-Enabled": "true",
      },
      body: JSON.stringify({
        model,
        query: PROBE.query,
        documents: [PROBE.relevant, PROBE.irrelevant],
        top_n: 2,
      }),
    });
  } catch (error) {
    return { ok: false, scores: [], fieldUsed: "-", detail: `请求失败：${String(error)}` };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, scores: [], fieldUsed: "-", detail: `HTTP ${response.status} ${detail.slice(0, 200)}` };
  }

  const body = (await response.json()) as {
    results?: Array<Record<string, unknown>>;
  };
  const results = body.results ?? [];
  if (results.length === 0) {
    return { ok: false, scores: [], fieldUsed: "-", detail: "响应里没有 results，字段形状与预期不符" };
  }

  const sample = results[0] as Record<string, unknown>;
  const field = "relevance_score" in sample ? "relevance_score" : "score" in sample ? "score" : null;
  if (!field) {
    return {
      ok: false,
      scores: [],
      fieldUsed: "-",
      detail: `results[0] 既没有 relevance_score 也没有 score，实际键：${Object.keys(sample).join(", ")}`,
    };
  }
  return {
    ok: true,
    scores: results.map((item) => Number(item[field])),
    fieldUsed: field,
    detail: "OK",
  };
}

async function probeEmbedding(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; dimension: number | null; detail: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Failover-Enabled": "true",
      },
      body: JSON.stringify({ model, input: [PROBE.query] }),
    });
  } catch (error) {
    return { ok: false, dimension: null, detail: `请求失败：${String(error)}` };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, dimension: null, detail: `HTTP ${response.status} ${detail.slice(0, 200)}` };
  }
  const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = body.data?.[0]?.embedding;
  if (!vector) return { ok: false, dimension: null, detail: "响应里没有 data[0].embedding" };
  return { ok: true, dimension: vector.length, detail: "OK" };
}

/** 读一个 Qdrant collection 的向量维度，用于判断"换 embedding 后要不要重建 collection" */
async function collectionDimension(collection: string): Promise<number | null> {
  const url = process.env.QDRANT_URL ?? "http://localhost:6333";
  try {
    const response = await fetch(`${url}/collections/${encodeURIComponent(collection)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      result?: { config?: { params?: { vectors?: { size?: number } } } };
    };
    return body.result?.config?.params?.vectors?.size ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const rerankBase = process.env.RERANK_BASE_URL ?? "(未设置)";
  const rerankModel = process.env.RERANK_MODEL ?? "(未设置)";
  const embedBase = process.env.EMBEDDING_BASE_URL ?? "(未设置)";
  const embedModel = process.env.EMBEDDING_MODEL ?? "(未设置)";

  console.log("当前配置");
  console.log(`  RERANK_BASE_URL     ${rerankBase}`);
  console.log(`  RERANK_MODEL        ${rerankModel}`);
  console.log(`  RERANK_API_KEY      ${mask(process.env.RERANK_API_KEY)}`);
  console.log(`  EMBEDDING_BASE_URL  ${embedBase}`);
  console.log(`  EMBEDDING_MODEL     ${embedModel}`);
  console.log(`  EMBEDDING_API_KEY   ${mask(process.env.EMBEDDING_API_KEY)}`);
  console.log(`  QDRANT_COLLECTION   ${process.env.QDRANT_COLLECTION_NAME ?? "(未设置)"}`);
  console.log(
    `\n  实际请求地址（客户端会自己拼路径，base 里带路径段就会拼重）：` +
      `\n    POST ${rerankBase.replace(/\/$/, "")}/rerank` +
      `\n    POST ${embedBase.replace(/\/$/, "")}/embeddings`,
  );

  const problems: string[] = [];

  // ── rerank：路径 + 字段 + 尺度 ─────────────────────────────────
  console.log("\n[1/3] rerank 接口");
  const rerank = await probeRerank(rerankBase, process.env.RERANK_API_KEY ?? "", rerankModel);
  if (!rerank.ok) {
    console.log(`  ${RED}✗${RESET} ${rerank.detail}`);
    problems.push(`rerank 调用失败：${rerank.detail}`);
  } else {
    console.log(`  ${GREEN}✓${RESET} 响应字段 \`${rerank.fieldUsed}\`，返回 ${rerank.scores.length} 条`);
    const [relevant, irrelevant] = rerank.scores;
    console.log(`    相关文本   ${relevant}   ${DIM}(硅基流动实测参照 ${REFERENCE.relevant})${RESET}`);
    console.log(`    不相关文本 ${irrelevant}   ${DIM}(硅基流动实测参照 ${REFERENCE.irrelevant})${RESET}`);

    const inUnitRange = rerank.scores.every((score) => score >= 0 && score <= 1);
    if (!inUnitRange) {
      console.log(
        `  ${RED}✗ 分数超出 [0,1]，疑似原始 logit${RESET} —— ` +
          `现役 floor/solid 与全部 profile 都是 sigmoid 尺度，**不可直接迁移**，必须重新标定`,
      );
      problems.push("rerank 分数疑似 logit 尺度，需重标定");
    } else if (
      relevant !== undefined &&
      irrelevant !== undefined &&
      relevant - irrelevant < 0.2
    ) {
      console.log(`  ${YELLOW}⚠ 相关与不相关的分差过小（${(relevant - irrelevant).toFixed(4)}），排序能力可疑${RESET}`);
      problems.push("rerank 分差过小");
    } else {
      console.log(`  ${GREEN}✓ 尺度为 [0,1]，与现役标定同量纲${RESET}`);
      const gap = Math.abs((relevant ?? 0) - REFERENCE.relevant);
      if (gap > 0.15) {
        console.log(
          `  ${YELLOW}⚠ 相关文本得分 ${relevant} 与硅基流动参照 ${REFERENCE.relevant} 差 ${gap.toFixed(2)}：` +
            `同量纲但**零点可能不同**，阈值建议按新供应商重标一轮${RESET}`,
        );
      }
    }
  }

  // ── embedding：维度 + 与 collection 是否匹配 ────────────────────
  console.log("\n[2/3] embedding 接口");
  const embedding = await probeEmbedding(embedBase, process.env.EMBEDDING_API_KEY ?? "", embedModel);
  const collection = process.env.QDRANT_COLLECTION_NAME ?? "rag_boot";
  if (!embedding.ok) {
    console.log(`  ${RED}✗${RESET} ${embedding.detail}`);
    problems.push(`embedding 调用失败：${embedding.detail}`);
  } else {
    console.log(`  ${GREEN}✓${RESET} 维度 ${embedding.dimension}`);
    const current = await collectionDimension(collection);
    if (current === null) {
      console.log(`  ${YELLOW}⚠ 读不到 Qdrant collection「${collection}」的维度（库没起或集合不存在）${RESET}`);
    } else if (current === embedding.dimension) {
      console.log(
        `  ${GREEN}✓ 与 collection「${collection}」的 ${current} 维一致${RESET}` +
          `  ${DIM}(维度一致不等于向量空间一致：换模型必须重新灌库)${RESET}`,
      );
    } else {
      console.log(
        `  ${RED}✗ 维度不一致${RESET}：embeddings 出 ${embedding.dimension}，` +
          `collection「${collection}」是 ${current} 维 —— 必须重建 collection 并重新灌库`,
      );
      problems.push("embedding 维度与 collection 不一致，需重建 collection");
    }
  }

  // ── 模型名写法 ─────────────────────────────────────────────────
  console.log("\n[3/3] 模型名写法");
  const notes: string[] = [];
  if (rerankBase.includes("siliconflow") && !rerankModel.includes("/")) {
    notes.push(`硅基流动的模型名**必须带前缀**，当前 \`${rerankModel}\` 缺前缀`);
  }
  if ((rerankBase.includes("gitee") || rerankBase.includes("moark")) && rerankModel.includes("/")) {
    notes.push(`模力方舟的模型名**不带前缀**，当前 \`${rerankModel}\` 多写了前缀`);
  }
  if (embedBase.includes("gitee") || embedBase.includes("moark")) {
    // 只在**真的失败**时才提这条：令牌可用时还去警告"需先充值"是没观测就断言，
    // 会把一个能用的配置说成有问题，比不说更糟。
    notes.push(
      problems.length > 0
        ? "模力方舟需要令牌已启用（历史上要充值，最低 10 元）；若上面是 401/402，通常是未充值或当天额度用尽（免费额度为全平台每天 100 次）"
        : "模力方舟免费额度为全平台每天 100 次，做批量实验前先估一下调用量",
    );
  }
  if (notes.length === 0) console.log(`  ${GREEN}✓${RESET} 未发现明显前缀问题`);
  for (const note of notes) console.log(`  ${YELLOW}⚠ ${note}${RESET}`);

  console.log("\n" + "=".repeat(70));
  if (problems.length === 0) {
    console.log(`${GREEN}结论：当前配置可直接使用${RESET}`);
  } else {
    console.log(`${RED}结论：当前配置不可直接使用${RESET}`);
    for (const problem of problems) console.log(`  · ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
