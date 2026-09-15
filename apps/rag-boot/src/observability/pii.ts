/**
 * T8.2 PII 与留存
 *
 * 两个约束必须同时满足，且互相拉扯：
 * - 审计日志里不能出现明文手机号 / 身份证 / 银行卡 / 地址
 * - 脱敏不能破坏排障所需的结构信息（清单 697 行）
 *
 * 折中做法是**保形脱敏**：保留类型标记、长度与前后缀，只抹掉中间可识别段。
 * 排障时能看出「这里有个手机号、11 位、138 开头」，但拿不到完整号码。
 */

export interface PiiRule {
  name: string;
  pattern: RegExp;
  /** 保留的前后字符数 */
  keepHead?: number;
  keepTail?: number;
  /** 脱敏后的类型标记，保留结构信息 */
  label?: string;
}

const mask = (value: string, head = 0, tail = 0): string => {
  if (value.length <= head + tail) return "*".repeat(value.length);
  const h = value.slice(0, head);
  const t = tail > 0 ? value.slice(-tail) : "";
  return `${h}${"*".repeat(value.length - head - tail)}${t}`;
};

export const DEFAULT_PII_RULES: PiiRule[] = [
  // 中国大陆手机号：11 位，1[3-9] 开头
  { name: "phone", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, keepHead: 3, keepTail: 4, label: "PHONE" },
  // 邮箱：保留域名（排障需要知道是哪个域的账号）
  {
    name: "email",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
    keepHead: 2,
    keepTail: 0,
    label: "EMAIL",
  },
  // 身份证：18 位
  { name: "idcard", pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g, keepHead: 6, keepTail: 4, label: "IDCARD" },
  // 银行卡：16-19 位
  { name: "bankcard", pattern: /(?<!\d)\d{16,19}(?!\d)/g, keepHead: 4, keepTail: 4, label: "BANKCARD" },
  // 常见中文地址字段：保留字段与少量前缀，避免审计日志暴露完整住址
  {
    name: "address",
    pattern: /(?:地址|住址)[：:]?([^,，。；;\n]{4,80})/g,
    keepHead: 2,
    keepTail: 0,
    label: "ADDRESS",
  },
];

/** 文本脱敏：命中规则的片段做保形替换 */
export function redactText(text: string, rules: PiiRule[] = DEFAULT_PII_RULES): string {
  if (!text) return text;
  let out = text;
  for (const rule of rules) {
    out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (m) => {
      if (rule.name === "email") {
        const [, domain] = m.split("@");
        return `${mask(m.split("@")[0], rule.keepHead, 0)}@${domain}`;
      }
      if (rule.name === "address") {
        const match = /^(地址|住址)([：:]?)(.*)$/u.exec(m);
        if (match) return `${match[1]}${match[2]}${mask(match[3], rule.keepHead, rule.keepTail)}`;
      }
      return mask(m, rule.keepHead ?? 0, rule.keepTail ?? 0);
    });
  }
  return out;
}

/** 命中了哪些 PII 类型（用于「原文仅存于受控存储」的分流判断，T4.1） */
export function detectPii(text: string, rules: PiiRule[] = DEFAULT_PII_RULES): string[] {
  const hits = new Set<string>();
  for (const rule of rules) {
    if (new RegExp(rule.pattern.source, rule.pattern.flags).test(text)) hits.add(rule.name);
  }
  return [...hits];
}

/** 结构化对象脱敏：键名保留（结构信息），值脱敏 */
export function redactObject<T>(value: T, rules: PiiRule[] = DEFAULT_PII_RULES): T {
  return redactObjectForClearance(value, "masked", rules);
}

export function redactObjectForClearance<T>(
  value: T, clearance: AgentClearance, rules: PiiRule[] = DEFAULT_PII_RULES,
): T {
  if (typeof value === "string") {
    // Tool summaries are often serialized JSON. Parse them to preserve structure and key-aware masking.
    if (/^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(redactObjectForClearance(JSON.parse(value), clearance, rules)) as T;
      } catch { /* Non-JSON prose uses text redaction below. */ }
    }
    return redactForClearance(value, clearance, rules) as T;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactObjectForClearance(v, clearance, rules)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:confirmToken|confirmationToken|password|secret|accessToken|authorization|credential)$/i.test(k)) {
      out[k] = "[REDACTED]";
    } else if (clearance !== "full" && /^(?:phone|mobile|email|address|idCard|bankCard|姓名|地址|住址|手机号)$/i.test(k) && v != null) {
      out[k] = clearance === "none" ? "[REDACTED]" : mask(String(v), 2, 0);
    } else {
      out[k] = redactObjectForClearance(v, clearance, rules);
    }
  }
  return out as T;
}

/** 坐席可见范围：决定交接包里 PII 的脱敏强度（T5.2） */
export type AgentClearance = "none" | "masked" | "full";

export function redactForClearance(
  text: string,
  clearance: AgentClearance,
  rules: PiiRule[] = DEFAULT_PII_RULES,
): string {
  if (clearance === "full") return text;
  if (clearance === "none") {
    // 完全不可见：连类型标记都不留
    let result = text;
    for (const rule of rules) result = result.replace(new RegExp(rule.pattern.source, rule.pattern.flags), "[REDACTED]");
    return result.replace(/\d/g, "*");
  }
  return redactText(text, rules);
}

export type RetentionKind = "audit" | "session" | "persistence";

export interface RetentionPolicy {
  /** 会话数据保留时长（毫秒） */
  sessionTtlMs: number;
  /** 审计日志保留时长（毫秒） */
  auditTtlMs: number;
  /** 持久化目标（checkpoint、幂等记录、知识变更记录等）保留时长（毫秒） */
  persistenceTtlMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  sessionTtlMs: 180 * 24 * 60 * 60 * 1000,
  auditTtlMs: 365 * 24 * 60 * 60 * 1000,
  persistenceTtlMs: 365 * 24 * 60 * 60 * 1000,
};

export interface RetentionTarget {
  name: string;
  /** 显式分类优先于 name 推断，兼容现有只传 name 的目标。 */
  kind?: RetentionKind;
  purge(olderThanMs: number): Promise<number> | number;
}

function retentionKind(target: RetentionTarget): RetentionKind {
  if (target.kind) return target.kind;
  const name = target.name.toLowerCase();
  if (name.includes("audit") || name.includes("审计")) return "audit";
  if (
    name.includes("session") ||
    name.includes("会话") ||
    name.includes("conversation")
  ) return "session";
  return "persistence";
}

/** 统一的 PII 安全审计记录器；写入前递归脱敏，避免调用方忘记处理 payload。 */
export class AuditLog implements RetentionTarget {
  readonly name = "audit-log";
  readonly kind = "audit" as const;
  private readonly records: Array<{ at: number; data: unknown }> = [];
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  append(data: unknown, at = this.clock()): void {
    this.records.push({ at, data: redactObject(data) });
  }

  entries(): Array<{ at: number; data: unknown }> {
    return this.records.map((entry) => ({ ...entry }));
  }

  purge(olderThanMs: number): number {
    const before = this.records.length;
    const remaining = this.records.filter((entry) => entry.at >= olderThanMs);
    this.records.length = 0;
    this.records.push(...remaining);
    return before - remaining.length;
  }
}

/**
 * 留存清理任务。
 *
 * 按「审计 / 会话 / 持久化」三类目标分别计算 cutoff，避免 checkpoint 或
 * 幂等记录被错误地套用会话 TTL；单测可注入 fake target，不需要真跑定时器。
 */
export class RetentionRunner {
  private readonly targets: RetentionTarget[] = [];
  private readonly policy: RetentionPolicy;

  constructor(policy: Partial<RetentionPolicy> = {}) {
    this.policy = { ...DEFAULT_RETENTION, ...policy };
  }

  register(target: RetentionTarget): void {
    this.targets.push(target);
  }

  /** 返回 { target, removed }[]，保持现有调用方的返回结构。 */
  async run(now: number = Date.now()): Promise<Array<{ target: string; removed: number }>> {
    const report: Array<{ target: string; removed: number }> = [];
    for (const target of this.targets) {
      const kind = retentionKind(target);
      const ttl =
        kind === "audit"
          ? this.policy.auditTtlMs
          : kind === "session"
            ? this.policy.sessionTtlMs
            : this.policy.persistenceTtlMs;
      const removed = await target.purge(now - ttl);
      report.push({ target: target.name, removed });
    }
    return report;
  }
}
