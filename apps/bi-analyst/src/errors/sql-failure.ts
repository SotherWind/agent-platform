/** SQL 执行失败分类 —— 仅部分类型允许自愈重试 */
export type SqlFailureKind =
  | "syntax_error"
  | "unknown_table"
  | "unknown_column"
  | "permission_denied"
  | "timeout"
  | "cost_rejected"
  | "policy_rejected"
  | "connection_error"
  | "unknown";

export interface SanitizedSqlError {
  kind: SqlFailureKind;
  safeMessage: string;
  /** 原始错误仅写入审计，不暴露给用户或 LLM */
  rawMessage?: string;
  retriable: boolean;
}

const RETRIABLE_KINDS: ReadonlySet<SqlFailureKind> = new Set([
  "syntax_error",
  "unknown_table",
  "unknown_column",
]);

/** 根据原始数据库错误推断失败类型 */
export function classifySqlError(rawMessage: string): SqlFailureKind {
  const msg = rawMessage.toLowerCase();

  if (/syntax|parse|malformed|unexpected token/i.test(rawMessage)) {
    return "syntax_error";
  }
  if (/no such table|unknown table|relation .* does not exist/i.test(msg)) {
    return "unknown_table";
  }
  if (/no such column|unknown column|column .* not found/i.test(msg)) {
    return "unknown_column";
  }
  if (/permission|denied|not authorized|access denied/i.test(msg)) {
    return "permission_denied";
  }
  if (/timeout|timed out|cancel/i.test(msg)) {
    return "timeout";
  }
  if (/connection|connect|econnrefused|enotfound/i.test(msg)) {
    return "connection_error";
  }
  if (/policy|rejected|not allowed|forbidden/i.test(msg)) {
    return "policy_rejected";
  }
  if (/cost|too many rows|limit exceeded/i.test(msg)) {
    return "cost_rejected";
  }
  return "unknown";
}

/** 脱敏后的用户/LLM 可见错误信息 */
export function sanitizeSqlError(
  rawMessage: string,
  kind?: SqlFailureKind,
): SanitizedSqlError {
  const resolvedKind = kind ?? classifySqlError(rawMessage);
  const safeMessage = toSafeMessage(resolvedKind, rawMessage);
  return {
    kind: resolvedKind,
    safeMessage,
    rawMessage,
    retriable: RETRIABLE_KINDS.has(resolvedKind),
  };
}

function toSafeMessage(kind: SqlFailureKind, raw: string): string {
  switch (kind) {
    case "syntax_error":
      return "SQL 语法错误，请检查语句结构";
    case "unknown_table":
      return "引用了未知或不存在的表";
    case "unknown_column":
      return "引用了未知或不存在的字段";
    case "permission_denied":
      return "无权访问请求的数据资源";
    case "timeout":
      return "查询执行超时";
    case "cost_rejected":
      return "查询成本超出限制";
    case "policy_rejected":
      return "查询违反安全策略";
    case "connection_error":
      return "数据源连接失败";
    default:
      return "查询执行失败";
  }
}

/** 是否允许进入 SQL 自愈重试 */
export function isRetriableFailure(kind: SqlFailureKind): boolean {
  return RETRIABLE_KINDS.has(kind);
}

/** 供 LLM 重试 prompt 使用的脱敏错误描述 */
export function formatErrorForLlm(error: SanitizedSqlError): string {
  return `${error.kind}: ${error.safeMessage}`;
}
