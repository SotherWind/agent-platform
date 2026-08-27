/**
 * 业务日历与时间范围解析（Phase C）。
 * 支持澄清选项 ID（range.*）与自然语言「近 N 天 / 上个月 / 本财年」等。
 */

export interface ResolvedTimeRange {
  from: string;
  to: string;
  timezone: string;
  preset?: string;
  label?: string;
}

export interface BusinessCalendarOptions {
  timezone?: string;
  /** 财年起始月（1–12），默认 1（自然年） */
  fiscalYearStartMonth?: number;
  /** 可注入时钟，便于单测 */
  now?: Date;
}

const PRESET_LABELS: Record<string, string> = {
  "range.last_7d": "近 7 天",
  "range.last_30d": "近 30 天",
  "range.last_month": "上个月",
  "range.this_month": "本月",
  "range.this_quarter": "本季度",
  "range.last_quarter": "上季度",
  "range.this_fiscal_year": "本财年",
  "range.last_fiscal_year": "上一财年",
};

/** 澄清选项：缺时间范围时返回给前端 */
export function timeRangeClarificationOptions(): Array<{
  id: string;
  label: string;
}> {
  return Object.entries(PRESET_LABELS).map(([id, label]) => ({ id, label }));
}

/**
 * 解析澄清选项 ID 或别名 → 绝对日期范围（YYYY-MM-DD，含首尾）。
 * 边界按 timezone 的「本地日历日」计算；输出为日历日期字符串。
 */
export function resolveTimeRangePreset(
  presetId: string,
  options: BusinessCalendarOptions = {},
): ResolvedTimeRange | null {
  const timezone = options.timezone ?? "Asia/Shanghai";
  const fiscalStart = clampMonth(options.fiscalYearStartMonth ?? 1);
  const now = options.now ?? new Date();
  const local = toZonedParts(now, timezone);
  const id = normalizePresetId(presetId);
  if (!id) return null;

  let from: Ymd;
  let to: Ymd;

  switch (id) {
    case "range.last_7d": {
      to = local;
      from = addDays(local, -6);
      break;
    }
    case "range.last_30d": {
      to = local;
      from = addDays(local, -29);
      break;
    }
    case "range.this_month": {
      from = { y: local.y, m: local.m, d: 1 };
      to = local;
      break;
    }
    case "range.last_month": {
      const prev = addMonths({ y: local.y, m: local.m, d: 1 }, -1);
      from = prev;
      to = lastDayOfMonth(prev.y, prev.m);
      break;
    }
    case "range.this_quarter": {
      const quarter = Math.floor((local.m - 1) / 3);
      from = { y: local.y, m: quarter * 3 + 1, d: 1 };
      to = local;
      break;
    }
    case "range.last_quarter": {
      const q = Math.floor((local.m - 1) / 3); // 0..3 current
      const prevQ = q === 0 ? 3 : q - 1;
      const year = q === 0 ? local.y - 1 : local.y;
      const startMonth = prevQ * 3 + 1;
      from = { y: year, m: startMonth, d: 1 };
      to = lastDayOfMonth(year, startMonth + 2);
      break;
    }
    case "range.this_fiscal_year": {
      from = fiscalYearStart(local, fiscalStart);
      to = local;
      break;
    }
    case "range.last_fiscal_year": {
      const thisStart = fiscalYearStart(local, fiscalStart);
      const lastStart = addMonths(thisStart, -12);
      from = lastStart;
      to = addDays(thisStart, -1);
      break;
    }
    default:
      return null;
  }

  return {
    from: formatYmd(from),
    to: formatYmd(to),
    timezone,
    preset: id,
    label: PRESET_LABELS[id],
  };
}

/** 从自然语言推断时间范围；无法识别时返回 null */
export function inferTimeRangeFromQuery(
  query: string,
  options: BusinessCalendarOptions = {},
): ResolvedTimeRange | null {
  const q = query.trim();
  if (!q) return null;

  if (/本财年|本会计年度|this fiscal year/i.test(q)) {
    return resolveTimeRangePreset("range.this_fiscal_year", options);
  }
  if (/上[一]?财年|上一会计年度|last fiscal year/i.test(q)) {
    return resolveTimeRangePreset("range.last_fiscal_year", options);
  }
  if (/上[个]?季度|上季|last quarter/i.test(q)) {
    return resolveTimeRangePreset("range.last_quarter", options);
  }
  if (/本季度|本季|this quarter/i.test(q)) {
    return resolveTimeRangePreset("range.this_quarter", options);
  }
  if (/上[个]?月|上个月|last month/i.test(q)) {
    return resolveTimeRangePreset("range.last_month", options);
  }
  if (/本月|这个月|this month/i.test(q)) {
    return resolveTimeRangePreset("range.this_month", options);
  }
  if (/近\s*30\s*天|最近\s*30\s*天|过去\s*30\s*天|last\s*30\s*days?/i.test(q)) {
    return resolveTimeRangePreset("range.last_30d", options);
  }
  if (/近\s*7\s*天|最近\s*7\s*天|过去\s*7\s*天|近一周|最近一周|last\s*7\s*days?/i.test(q)) {
    return resolveTimeRangePreset("range.last_7d", options);
  }

  return null;
}

function normalizePresetId(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (PRESET_LABELS[s]) return s;
  if (PRESET_LABELS[`range.${s}`]) return `range.${s}`;
  const aliases: Record<string, string> = {
    last_7d: "range.last_7d",
    last_30d: "range.last_30d",
    last_month: "range.last_month",
    this_month: "range.this_month",
    last_quarter: "range.last_quarter",
    this_fiscal_year: "range.this_fiscal_year",
    last_fiscal_year: "range.last_fiscal_year",
  };
  return aliases[s] ?? null;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function clampMonth(m: number): number {
  if (!Number.isFinite(m)) return 1;
  return Math.min(12, Math.max(1, Math.trunc(m)));
}

function fiscalYearStart(local: Ymd, fiscalStartMonth: number): Ymd {
  if (local.m >= fiscalStartMonth) {
    return { y: local.y, m: fiscalStartMonth, d: 1 };
  }
  return { y: local.y - 1, m: fiscalStartMonth, d: 1 };
}

function toZonedParts(date: Date, timeZone: string): Ymd {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return { y, m, d };
}

function formatYmd(v: Ymd): string {
  return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function lastDayOfMonth(y: number, m: number): Ymd {
  return { y, m, d: daysInMonth(y, m) };
}

function addDays(base: Ymd, delta: number): Ymd {
  const utc = Date.UTC(base.y, base.m - 1, base.d + delta);
  const d = new Date(utc);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
  };
}

function addMonths(base: Ymd, delta: number): Ymd {
  const total = base.y * 12 + (base.m - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const dim = daysInMonth(y, m);
  return { y, m, d: Math.min(base.d, dim) };
}
