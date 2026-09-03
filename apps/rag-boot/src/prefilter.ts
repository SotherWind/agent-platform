/**
 * T9.3 前置拦截与直答
 *
 * 依据架构图：未命中才进入 LLM 链路，用于控成本与 P95。
 *
 * 这是整条链路里**唯一零模型调用就能完整应答**的一层。Diffco 阶段 1 明确写了
 * 「接入与归一化：纯代码，零模型调用」——把高频、确定性、无歧义的输入在这层
 * 消化掉，是成本优化里性价比最高的一个抓手（清单 769 行：直答命中率可观测，
 * 这是成本优化的主要抓手之一）。
 */
import { isHumanRequest } from "./escalation";
import { countTokens } from "./tokens";

export type PrefilterHit = "blacklist" | "faq" | "chitchat" | "human_request" | null;

export type PrefilterAction = "block" | "direct" | "escalate" | "continue";

export interface PrefilterResult {
  hit: PrefilterHit;
  action: PrefilterAction;
  /** 直答内容 / 拦截话术 */
  answer: string;
  reason: string;
  /** 本次直答节省的 token 估算（走完整链路本来要花的上下文 + 生成预算） */
  savedTokens: number;
}

export interface FaqEntry {
  id: string;
  /** 命中任一即算命中 */
  patterns: RegExp[];
  answer: string;
  /** 限定租户；undefined 表示全租户通用 */
  tenantId?: string;
}

export interface PrefilterOptions {
  faqs?: FaqEntry[];
  blacklist?: RegExp[];
  chitchatPatterns?: RegExp[];
  chitchatReply?: string;
  /** 直答节省 token 的估算基准：一次典型链路的 context + 生成预算 */
  savedTokensPerHit?: number;
}

export const DEFAULT_CHITCHAT_PATTERNS: RegExp[] = [
  /^(你好|您好|hi|hello|hey)\s*[!！。.!]?$/i,
  /^(谢谢|感谢|thanks|thank you)\s*[!！。.!]?$/i,
  /^(在吗|在么|有人吗)\s*[?？]?$/i,
  /^(嗯|哦|ok|好的)\s*[!！。.!]?$/i,
  /^(再见|拜拜|bye)\s*[!！。.!]?$/i,
];

export const DEFAULT_CHITCHAT_REPLY =
  "你好，我是智能客服助手。有什么可以帮你的？如果是订单、账单或集成配置方面的问题，直接描述即可，我会为你查询。";

export const DEFAULT_BLACKLIST_REPLY =
  "你的消息包含不被允许的内容，无法继续处理。如有疑问请回复「转人工」联系人工客服。";

/** 内置通用 FAQ。生产应各租户自带（知识库生命周期 T8.3 管这部分） */
export const DEFAULT_FAQS: FaqEntry[] = [
  {
    id: "faq-invoice-howto",
    patterns: [/怎么(开|申请)发票/, /发票(怎么|如何)(开|申请|要)/, /开票流程/],
    answer:
      "开票路径：控制台 → 账户中心 → 发票管理 → 申请开票。可选择电子发票（1 个工作日内开出）或纸质发票（5 个工作日寄出）。如需查询具体某张发票的进度，回复「转人工」由人工为你核对。",
  },
  {
    id: "faq-reset-password",
    patterns: [/怎么(重置|修改)密码/, /忘记密码/, /密码(怎么|如何)(重置|改)/],
    answer:
      "重置密码：登录页点击「忘记密码」→ 输入注册邮箱 → 查收重置邮件（5 分钟内到达，注意垃圾箱）→ 链接 30 分钟内有效。若收不到邮件，回复「转人工」由人工协助。",
  },
  {
    id: "faq-business-hours",
    patterns: [/客服(工作|上班)时间/, /(你们)?几点(到几点|下班)/, /人工客服(在吗|时间)/],
    answer: "人工客服在线时间为工作日 9:00-21:00，非工作时间会转为留言，下一个工作日 2 小时内回复。",
  },
];

/**
 * 前置拦截器。纯规则，零模型调用。
 *
 * 顺序：黑名单 → 明确指令（转人工）→ FAQ 直答 → 闲聊兜底 → 放行。
 * 黑名单第一（不合法输入不该享受任何后续服务），
 * 明确指令第二（用户已经说了要什么，问模型是自作主张）。
 */
export class Prefilter {
  private readonly faqs: FaqEntry[];
  private readonly blacklist: RegExp[];
  private readonly chitchat: RegExp[];
  private readonly chitchatReply: string;
  private readonly savedTokensPerHit: number;
  private readonly stats = {
    total: 0,
    hits: 0,
    byType: {} as Record<string, number>,
    savedTokens: 0,
  };

  constructor(options: PrefilterOptions = {}) {
    this.faqs = options.faqs ?? DEFAULT_FAQS;
    this.blacklist = options.blacklist ?? [];
    this.chitchat = options.chitchatPatterns ?? DEFAULT_CHITCHAT_PATTERNS;
    this.chitchatReply = options.chitchatReply ?? DEFAULT_CHITCHAT_REPLY;
    this.savedTokensPerHit = options.savedTokensPerHit ?? 2200;
  }

  run(text: string, ctx: { tenantId?: string } = {}): PrefilterResult {
    this.stats.total += 1;
    const trimmed = (text ?? "").trim();

    if (!trimmed) {
      return {
        hit: null,
        action: "continue",
        answer: "",
        reason: "empty input",
        savedTokens: 0,
      };
    }

    // 1) 黑名单：零 LLM 调用，直接短路
    for (const p of this.blacklist) {
      if (p.test(trimmed)) {
        return this.record("blacklist", {
          hit: "blacklist",
          action: "block",
          answer: DEFAULT_BLACKLIST_REPLY,
          reason: "命中黑名单",
          savedTokens: this.savedTokensPerHit,
        });
      }
    }

    // 2) 明确指令：直接路由，不经过 triage 模型
    if (isHumanRequest(trimmed)) {
      return this.record("human_request", {
        hit: "human_request",
        action: "escalate",
        answer: "",
        reason: "用户明确要求转人工",
        savedTokens: this.savedTokensPerHit,
      });
    }

    // 3) FAQ 直答：不走检索与生成
    for (const faq of this.faqs) {
      if (faq.tenantId && ctx.tenantId && faq.tenantId !== ctx.tenantId) continue;
      if (faq.patterns.some((p) => p.test(trimmed))) {
        return this.record("faq", {
          hit: "faq",
          action: "direct",
          answer: faq.answer,
          reason: `命中 FAQ「${faq.id}」`,
          // 直答省下的是「本来要进 prompt 的上下文 + 生成输出」两部分
          savedTokens: this.savedTokensPerHit + countTokens(faq.answer),
        });
      }
    }

    // 4) 闲聊兜底：不消耗主模型
    if (this.chitchat.some((p) => p.test(trimmed))) {
      return this.record("chitchat", {
        hit: "chitchat",
        action: "direct",
        answer: this.chitchatReply,
        reason: "闲聊兜底",
        savedTokens: this.savedTokensPerHit,
      });
    }

    return {
      hit: null,
      action: "continue",
      answer: "",
      reason: "未命中任何前置规则",
      savedTokens: 0,
    };
  }

  private record(type: PrefilterHit, result: PrefilterResult): PrefilterResult {
    this.stats.hits += 1;
    const key = String(type);
    this.stats.byType[key] = (this.stats.byType[key] ?? 0) + 1;
    this.stats.savedTokens += result.savedTokens;
    return result;
  }

  /** 直答命中率观测：T9.3 的验收点 */
  metrics(): {
    total: number;
    hits: number;
    hitRate: number;
    byType: Record<string, number>;
    savedTokens: number;
  } {
    return {
      total: this.stats.total,
      hits: this.stats.hits,
      hitRate: this.stats.total > 0 ? this.stats.hits / this.stats.total : 0,
      byType: { ...this.stats.byType },
      savedTokens: this.stats.savedTokens,
    };
  }
}
