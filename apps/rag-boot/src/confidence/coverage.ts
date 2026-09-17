/**
 * 属性覆盖判据：把"知识库答不答得了"从**相似度**问题改写成**属性是否真的被给出**的问题。
 *
 * ## ⚠️ 实测结论：它比基线更差，不要直接拿它替换 topScore 阈值
 *
 * 在 84 条同源样本上（42 个合成问题，各跑"承载章节在场"与"消融"两遍；
 * 真 reranker，**不调模型**，`pnpm probe:user-sim --judge-compare`）：
 *
 * | 判据 | 误伤（可答被判低置信） | 漏放（答不了却放行） |
 * |------|----------------------|--------------------|
 * | `topScore < floor`（基线） | 10 / 42 = 23.8% | 11 / 42 = 26.2% |
 * | 属性覆盖（本模块） | 10 / 42 = **23.8%** | 21 / 42 = **50.0%** |
 *
 * 即：**误伤一点没改善，漏放翻了一倍。** 原因可诊断（不是"实现得不够好"）：
 *
 * 1. **漏放翻倍的根因**：词共现这个抽象太粗，会被**同一主体的另一个属性**满足。
 *    实测那条例外——问"退差价**多久能到账**"，检索到的上下文里有
 *    「一般商品：签收后 **15 天内**降价可**申请**价保。」：主体词（申请/降价）与属性（时长）
 *    都在同一句里，但那是**申请时限**，不是**到账时效**。
 *    要区分"同一主体的哪个属性"必须理解语义，而任何用模型做的语义判断都会带回
 *    "流畅文本偏向"这个原始病根——也就是我们要治的病。
 * 2. **误伤没被治好的原因**：26.2% 的样本上它**不表态**（问法不在规则表内、或只问到主体名），
 *    弃权后回落基线，于是该修的误伤原样留下。把规则表补全可以降低弃权率
 *    （已从 30.9% 降到 26.2%），但降不到 0——**总有一批问法没有可靠词法特征**。
 *
 * ## 那它为什么还留在仓库里
 *
 * - `compareJudges` 与脚本的 `--judge-compare` 模式构成一套**可复用的判据评测台**：
 *   任何未来的候选判据都可以在这批同源样本上直接跟基线比，不必先上线再发现更差。
 * - 本文件记录了一条**被测量过的死路**。不写下它，下一个人还会想"换个判据不就行了"，
 *   再花一遍同样的力气。
 *
 * ## 真正该往哪走（这一轮没做）
 *
 * 实测之后方向变了：问题不是"缺一个更好的判据"，而是这类**词法判据**判不了
 * "同一主体的不同属性"。可落地的替代路线是**不靠判据**：
 * ① 让答案必须引用"支撑它的那一句"，缺引用即 fail-closed；
 * ② 承认"低置信→兜底/转人工"是常态，按实测比例做成本预算；
 * ③ 从检索侧治——提高问题所问**参数**的可召回性，而不是事后判它有没有被召回。
 *
 * ## 判据在问什么（保留原设计说明）
 *
 * 不问"上下文像不像答案"，而问：**用户问的那个属性，上下文里到底有没有给出取值？**
 */
import { z } from "zod/v4";

export const AttributeTypeSchema = z.enum([
  "duration",
  "amount",
  "ratio",
  "count",
  "condition",
  "procedure",
  "capability",
  "identity",
]);
export type AttributeType = z.infer<typeof AttributeTypeSchema>;

interface AskRule {
  type: AttributeType;
  /** 问句里出现这些词，说明用户问的是该属性 */
  cue: RegExp;
  /** 上下文里出现这些模式，才说明该属性"被给出了取值" */
  provider: RegExp | null;
  /** 人话名称，用于报告 */
  label: string;
}

/**
 * 属性识别规则表。
 *
 * 顺序有意义：先长后短、先具体后笼统，避免"多少钱"被 `duration` 的 `/时间/` 之类抢走。
 * `provider` 为 null 表示**不判定**（宁可说判不了，也不要假判定）。
 */
export const ATTRIBUTE_RULES: AskRule[] = [
  { type: "duration", label: "时长/时效", cue: /(多久|多长时间|几天|几日|什么时候|哪天|时效|期限)/, provider: /(\d+(?:\.\d+)?)\s*(?:个)?(?:工作日|天|日|小时|分钟|个月|月|年)|实时|立即|当场/ },
  { type: "amount", label: "金额/费用", cue: /(多少钱|多少元|费用|运费|收费|扣多少|赔多少|赔付|报销|金额|上限)/, provider: /(\d+(?:\.\d+)?)\s*(?:元|块)/ },
  { type: "ratio", label: "比例", cue: /(百分之|比例|几成|几折|折扣)/, provider: /(\d+(?:\.\d+)?)\s*[%％]|百分之/ },
  { type: "count", label: "数量", cue: /(几张|几次|几件|几笔|几条|几个|多少个|几次内)/, provider: /(\d+)\s*(?:张|次|件|个|笔|条)/ },
  { type: "condition", label: "条件/前提", cue: /(条件|前提|需要什么|要求|什么样的)/, provider: /(需|须|应当|前提|满足|条件|不得|无法)/ },
  // 注意 `怎么(?!样)`：不加这个否定前瞻，"你们这个平台怎么样啊"会被误认成在问操作流程
  { type: "procedure", label: "操作路径", cue: /(怎么(?!样)|如何|步骤|流程|入口|在哪|哪里)/, provider: /(→|步骤|流程|入口|申请|提交)/ },
  // 注意这里**只认 `[吗么]`，不认 `?？`**：中文口语的是非问靠"吗/么"标记，
  // 而"能到账？""能申请退差价？"这类尾缀问号是陈述式追问，不是"是否支持"——
  // 把 `?？` 放进字符类会让它们全部误判成 capability（测出来过）。
  // 也注意 `[^。？?]{0,10}[吗么]`：口语会把"支持吗"拆成"支持货到付款吗"，
  // 只写 `/支持吗/` 会漏掉绝大多数真实问法（这是弃权率偏高的原因之一）。
  { type: "capability", label: "是否支持", cue: /(?:支持|可以|能|收不收)[^。？?]{0,10}[吗么]|是否支持|能不能|可不可以|收不收|可以退|能退/, provider: /(支持|不支持|可以|不可|能够|不能|无法|允许|禁止)/ },
  // 主体名判定不了：没有可靠的词法特征能区分"某某公司"是真的实体还是泛称
  { type: "identity", label: "主体/机构", cue: /(哪家|哪个公司|哪家公司|谁|什么公司)/, provider: null },
];

export interface AskedAttribute {
  type: AttributeType;
  label: string;
  /** 命中的问法词 */
  cue: string;
}

/** 识别问题在问哪些属性（一个问题可能同时问多个，例如"多久、收多少钱"） */
export function detectAskedAttributes(question: string): AskedAttribute[] {
  const found: AskedAttribute[] = [];
  for (const rule of ATTRIBUTE_RULES) {
    const match = rule.cue.exec(question);
    if (match) {
      found.push({ type: rule.type, label: rule.label, cue: match[0] });
    }
  }
  return found;
}

/** 问句停用词——这些不是主体，不能拿来当共现依据 */
const STOP_TERMS = new Set([
  "多久","多长时间","几天","几日","什么时候","哪天","时效","期限","多少钱","多少元",
  "费用","运费","收费","扣多少","报销","金额","上限","百分之","比例","几张","几次",
  "几件","几笔","几条","几个","条件","前提","需要什么","要求","怎么","如何","步骤",
  "流程","入口","哪里","可以吗","能吗","支持吗","行吗","能不能","可不可以","是否支持",
  "我","你们","我们","这个","那个","这","那","的","吗","呢","啊","了","不","是","在",
  "有","和","与","要","会","能","可以","请问","一下","啥","什么","哪个","哪家","谁",
]);

/**
 * 从问题里抽出可用来做共现的主体词。
 *
 * 用 2-4 字滑动窗口取片段并过滤停用词——粗糙是刻意的：这里只需要"够不够像在谈同一件事"，
 * 精确切词反而会漏掉口语化表达（"退差价""补开发票"这类词词典里根本没有）。
 */
export function subjectTerms(question: string): string[] {
  const cleaned = question.replace(/[？?！!。，,、；;：:（）()「」『』\s]/g, "");
  const terms = new Set<string>();
  for (let size = 4; size >= 2; size -= 1) {
    for (let i = 0; i + size <= cleaned.length; i += 1) {
      const gram = cleaned.slice(i, i + size);
      if (STOP_TERMS.has(gram)) continue;
      terms.add(gram);
    }
  }
  return [...terms];
}

const splitSentences = (text: string): string[] =>
  text.split(/[。！？；\n]/).map((s) => s.trim()).filter(Boolean);

export type AttributeVerdict = "supported" | "unsupported" | "unassessable";

export interface AttributeCoverage {
  type: AttributeType;
  label: string;
  verdict: AttributeVerdict;
  /** 给出该属性取值的句子（supported 时） */
  evidence?: string;
  reason: string;
}

export interface CoverageResult {
  assessed: AttributeCoverage[];
  /** 至少问到一个**可判定**的属性 */
  assessable: boolean;
  /** 所有可判定的属性都被上下文支持 */
  covered: boolean;
  /** 存在可判定但未被支持的属性 == 判"覆盖不足" */
  insufficient: boolean;
  reason: string;
}

/**
 * 判定"问题所问的属性在上下文里是否真的被给出了取值"。
 *
 * 判据 = 上下文里存在一句话，同时满足：
 * ① 含有该属性的**取值模式**（例如时长要有"3 个工作日"这类具体量）；
 * ② 含有问题里的**主体词**（滑窗片段之一）。
 *
 * ② 是为了避免"随便一句带数字的话"就算覆盖。但它挡不住"同一主体的另一个属性"，
 * 见文件头注释里的已知失效场景。
 */
export function assessCoverage(question: string, contextText: string): CoverageResult {
  const asked = detectAskedAttributes(question);
  const sentences = splitSentences(contextText);
  const terms = subjectTerms(question);

  if (asked.length === 0) {
    return {
      assessed: [],
      assessable: false,
      covered: false,
      insufficient: false,
      reason: "问题里没有识别到可判定的属性（问法不在规则表内），本判据不表态，交回调用方",
    };
  }

  const assessed: AttributeCoverage[] = asked.map((attribute) => {
    const rule = ATTRIBUTE_RULES.find((r) => r.type === attribute.type);
    if (!rule?.provider) {
      return {
        type: attribute.type,
        label: attribute.label,
        verdict: "unassessable" as const,
        reason: `「${attribute.label}」没有可靠词法特征，本判据不对它表态`,
      };
    }

    // 先找带取值的句子，再要求与主体词共现
    const withValue = sentences.filter((sentence) => rule.provider?.test(sentence) === true);
    const bound = withValue.find((sentence) => terms.some((term) => sentence.includes(term)));

    if (bound) {
      return {
        type: attribute.type,
        label: attribute.label,
        verdict: "supported" as const,
        evidence: bound,
        reason: `上下文里有句子同时给出「${attribute.label}」的取值与问题主体`,
      };
    }
    if (withValue.length > 0) {
      return {
        type: attribute.type,
        label: attribute.label,
        verdict: "unsupported" as const,
        reason:
          `上下文里有 ${withValue.length} 句给出了「${attribute.label}」的取值，` +
          `但都不是在谈问题所问的那件事（主体词未共现）`,
      };
    }
    return {
      type: attribute.type,
      label: attribute.label,
      verdict: "unsupported" as const,
      reason: `上下文里没有任何一句给出「${attribute.label}」的取值`,
    };
  });

  const judgeable = assessed.filter((item) => item.verdict !== "unassessable");
  if (judgeable.length === 0) {
    return {
      assessed,
      assessable: false,
      covered: false,
      insufficient: false,
      reason: "问到的属性全部不可判定，本判据不表态，交回调用方",
    };
  }

  const missing = judgeable.filter((item) => item.verdict === "unsupported");
  const insufficient = missing.length > 0;
  return {
    assessed,
    assessable: true,
    covered: !insufficient,
    insufficient,
    reason: insufficient
      ? `问到的「${missing.map((m) => m.label).join("、")}」在上下文里找不到取值 → 该判据认为知识库答不了`
      : `问到的「${judgeable.map((m) => m.label).join("、")}」在上下文里都有取值`,
  };
}

/** 判据在某条样本上的判决，用于新旧判据对比 */
export interface CoverageDecision {
  id: string;
  question: string;
  topScore: number;
  /** 旧判据：topScore < floor */
  oldFlags: boolean;
  /** 新判据：属性覆盖不足（不可判定时保守地不表态，返回 null） */
  newFlags: boolean | null;
  coverage: CoverageResult;
}

export interface JudgeComparison {
  total: number;
  /** 可判定（新判据表了态）的样本数 */
  assessable: number;
  /** 新判据中不表态、只能回落旧判据的比例 */
  abstainRate: number;
  old: { falseAlarm: number; missed: number; falseAlarmRate: number; missRate: number };
  new: { falseAlarm: number; missed: number; falseAlarmRate: number; missRate: number };
}

/**
 * 新旧判据在同一批样本上的 2×2 对比。
 *
 * `shouldEscalate` 在这里是**构造出来的真值**（可答样本的来源章节在场；
 * 消融样本的来源章节已被移除），不来自任何模型判断。
 */
export function compareJudges(
  rows: Array<{ decision: CoverageDecision; shouldEscalate: boolean }>,
): JudgeComparison {
  const positives = rows.filter((row) => row.shouldEscalate);
  const negatives = rows.filter((row) => !row.shouldEscalate);

  const oldAlarm = negatives.filter((row) => row.decision.oldFlags).length;
  const oldMiss = positives.filter((row) => !row.decision.oldFlags).length;
  // 不表态的样本按"交回旧判据"处理，这样对比不会因为新判据弃权而虚高
  const newAlarm = negatives.filter(
    (row) => (row.decision.newFlags ?? row.decision.oldFlags) === true,
  ).length;
  const newMiss = positives.filter(
    (row) => (row.decision.newFlags ?? row.decision.oldFlags) === false,
  ).length;

  const rate = (part: number, whole: number) =>
    whole === 0 ? 0 : Number((part / whole).toFixed(4));
  const assessable = rows.filter((row) => row.decision.newFlags !== null).length;

  return {
    total: rows.length,
    assessable,
    abstainRate: rate(rows.length - assessable, rows.length),
    old: {
      falseAlarm: oldAlarm,
      missed: oldMiss,
      falseAlarmRate: rate(oldAlarm, negatives.length),
      missRate: rate(oldMiss, positives.length),
    },
    new: {
      falseAlarm: newAlarm,
      missed: newMiss,
      falseAlarmRate: rate(newAlarm, negatives.length),
      missRate: rate(newMiss, positives.length),
    },
  };
}
