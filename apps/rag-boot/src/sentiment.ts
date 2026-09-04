/**
 * T5.1 情绪判定：确定性打分，不调模型。
 *
 * 为什么用规则而不是 LLM：转人工是安全兜底路径，不能依赖"模型有空且判得准"——
 * 模型超时/降级时恰恰最需要情绪触发。极端负面往往有强烈的字面信号（辱骂、投诉升级、
 * 连续感叹号），规则比模型更稳，且可回放、可单测、零延迟。
 *
 * 触发链路：turnStart 每轮对 query 打分 → state.sentiment / sentimentIntensity
 *          → escalateNode 传给 evaluateEscalation → negative_sentiment 触发转人工。
 */

export type SentimentPolarity = "negative" | "neutral" | "positive";

export interface SentimentScore {
  sentiment: SentimentPolarity;
  /** 0-1 的强度。转人工阈值由 escalationPolicy.sentimentIntensityThreshold 给（默认 0.8） */
  intensity: number;
}

/** 强负面：辱骂、威胁、投诉升级、监管曝光——单独命中就该显著拉高强度 */
const STRONG_NEGATIVE: Array<[RegExp, number]> = [
  [/垃圾|骗子|骗人|欺诈|耍赖|无耻|恶心|混蛋|智障|去死/g, 0.5],
  [/投诉|举报|曝光|律师|法院|起诉|报警/g, 0.5],
  [/315|消协|监管|工信部|工商|媒体/g, 0.5],
  [/忍无可忍|忍不了|太过分|欺人太甚|没法接受/g, 0.5],
];

/** 中负面：不满描述——单独命中不足以转人工，叠加后才够 */
const MILD_NEGATIVE: Array<[RegExp, number]> = [
  [/失望|生气|愤怒|火大|气死|崩溃|心累/g, 0.22],
  [/差评|太差|糟糕|离谱|莫名其妙|荒唐/g, 0.22],
  [/不负责任|推脱|推诿|敷衍|拖延|没人管|踢皮球/g, 0.22],
  [/坑|亏|损失|错误|又坏|还是不行|搞不定|解决不了/g, 0.22],
];

const POSITIVE: Array<[RegExp, number]> = [
  [/谢谢|感谢|多谢/g, 0.3],
  [/满意|很好|不错|赞|解决了|专业|贴心/g, 0.3],
];

/** 判定为负面的最低强度（低于此按 neutral 处理，不必惊动人工） */
const NEGATIVE_FLOOR = 0.25;

function countMatches(text: string, table: Array<[RegExp, number]>): { hits: number; weight: number } {
  let hits = 0;
  let weight = 0;
  for (const [pattern, w] of table) {
    const found = text.match(pattern);
    if (found) {
      hits += found.length;
      weight += w * Math.min(found.length, 2); // 同类词重复出现最多计 2 次，避免刷屏刷满
    }
  }
  return { hits, weight };
}

/**
 * 对一段用户输入打分。纯函数：同样输入必然同样输出。
 */
export function scoreSentiment(text: string): SentimentScore {
  if (!text || text.trim() === "") {
    return { sentiment: "neutral", intensity: 0 };
  }

  let negative = 0;
  let { hits: negativeHits } = countMatches(text, STRONG_NEGATIVE);
  const strong = countMatches(text, STRONG_NEGATIVE);
  const mild = countMatches(text, MILD_NEGATIVE);
  negative = strong.weight + mild.weight;
  negativeHits = strong.hits + mild.hits;

  // 强度修饰：语气与反复程度
  let modifier = 0;
  if (/[!！]{2,}/.test(text) || /[?？]{2,}/.test(text)) modifier += 0.2; // 连续感叹/质问
  if (/第三次|第四次|又|还|一直|天天|每次|反复|多次/.test(text)) modifier += 0.1; // 反复未解决
  if (text.length > 60 && negativeHits >= 3) modifier += 0.1; // 长段控诉
  if (/[A-Z]{8,}/.test(text)) modifier += 0.1; // 全大写喊话

  const intensity = Math.min(1, Number((negative + modifier).toFixed(4)));

  if (intensity >= NEGATIVE_FLOOR) {
    return { sentiment: "negative", intensity };
  }

  const positiveHits = countMatches(text, POSITIVE).hits;
  if (positiveHits > 0 && negative === 0) {
    return { sentiment: "positive", intensity: Math.min(1, countMatches(text, POSITIVE).weight) };
  }

  return { sentiment: "neutral", intensity };
}
