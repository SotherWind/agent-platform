/**
 * T2.2 Context Token 预算
 *
 * 依据 Fin：rerank 之后有 context budget filter，截断到约 1500 token 才进生成。
 * 当前实现只有 topN=5 的**条数**截断，没有 token 预算——条数一样但每篇 2000 字的
 * 时候，prompt 会 silently 膨胀数倍，成本与延迟都失控。
 *
 * 所以这里是「条数上限 + token 预算」双约束，且**预算是硬上限**（清单 326 行）。
 */
import type { RerankedChunk } from "../schema";
import { countTokens, truncateToTokens } from "../tokens";

export interface ContextBudgetOptions {
  /** token 预算（Fin 实践值约 1500） */
  maxTokens?: number;
  /** 条数上限 */
  maxChunks?: number;
  /** 单条 chunk 的最大 token，超了截断而非整条丢弃 */
  maxChunkTokens?: number;
}

export interface ContextBudgetResult {
  chunks: RerankedChunk[];
  /** 实际进入 prompt 的 token 数（T6.3 / T8.1 成本核算要用） */
  tokens: number;
  /** 因预算被整条丢弃的 chunk 数 */
  dropped: number;
  /** 被截断（而非丢弃）的 chunk 数 */
  truncated: number;
}

/**
 * 按 rerank 分数从高到低装填，装不下就丢低分。
 *
 * 三条边界：
 * - 至少保留 1 条最高分 chunk（预算极小时也不返回空上下文，否则生成必然是兜底话术）
 * - 单条超预算时截断而非整条丢弃（保住最高分那条的信息）
 * - 返回实际 token 数，喂给成本核算
 */
export function applyContextBudget(
  chunks: RerankedChunk[],
  options: ContextBudgetOptions = {},
): ContextBudgetResult {
  const maxTokens = options.maxTokens ?? 1500;
  const maxChunks = options.maxChunks ?? 5;
  const maxChunkTokens = options.maxChunkTokens ?? maxTokens;

  if (chunks.length === 0) {
    return { chunks: [], tokens: 0, dropped: 0, truncated: 0 };
  }

  // 高分优先：rerank 分数降序
  const ordered = [...chunks].sort((a, b) => b.rerankScore - a.rerankScore);

  const selected: RerankedChunk[] = [];
  let used = 0;
  let dropped = 0;
  let truncated = 0;

  for (const chunk of ordered) {
    if (selected.length >= maxChunks) {
      dropped++;
      continue;
    }

    const cost = countTokens(chunk.content);

    // 单条就超预算：截断它（只发生在它是第一条时；后续条直接丢弃）
    if (selected.length === 0 && cost > maxChunkTokens && maxTokens > 0) {
      const content = truncateToTokens(chunk.content, Math.min(maxTokens, maxChunkTokens));
      const tokenCost = countTokens(content);
      selected.push({ ...chunk, content });
      used += tokenCost;
      truncated++;
      continue;
    }

    if (used + cost > maxTokens) {
      // 一条都没装上：截断最高分那条，保证上下文非空
      if (selected.length === 0) {
        const content = truncateToTokens(chunk.content, maxTokens);
        selected.push({ ...chunk, content });
        used += countTokens(content);
        truncated++;
        continue;
      }
      dropped++;
      continue;
    }

    selected.push(chunk);
    used += cost;
  }

  // 正常预算为正时，即使第一条超预算也会截断后保留；
  // 非正预算属于显式的禁用上下文配置，必须优先满足硬上限，不返回超预算 chunk。
  if (selected.length === 0 && ordered.length > 0 && maxTokens > 0) {
    const content = truncateToTokens(ordered[0].content, maxTokens);
    selected.push({ ...ordered[0], content });
    used = countTokens(content);
    truncated++;
  }

  return { chunks: selected, tokens: used, dropped, truncated };
}

/**
 * T6.3 历史消息截断：不无限增长。
 *
 * 策略：保留最近 N 条，超出的按「最早的先丢」，但系统消息永远保留。
 */
export function truncateHistory<T extends { role: string; content: string }>(
  history: T[],
  maxMessages = 20,
): T[] {
  const system = history.filter((m) => m.role === "system");
  const rest = history.filter((m) => m.role !== "system");
  if (rest.length <= maxMessages) return history;
  return [...system, ...rest.slice(rest.length - maxMessages)];
}
