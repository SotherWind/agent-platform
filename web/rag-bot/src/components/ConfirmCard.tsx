import { Button, Tag } from "antd";

/** data-confirm part 的载荷（与服务端 chat-stream 发送形状一致） */
export interface ConfirmData {
  proposalId: string;
  action: string;
  summary: string;
  params: Record<string, unknown>;
  confirmToken: string;
  expiresAt: number;
}

interface Props {
  confirm: ConfirmData;
  /** 已提交确认（本轮已发送，等待服务端执行结果） */
  submitted: boolean;
  /** 用户主动放弃 */
  dismissed: boolean;
  onConfirm: (confirm: ConfirmData) => void;
  onDismiss: (proposalId: string) => void;
}

/** 参数里用户可读的键名映射 */
const PARAM_LABELS: Record<string, string> = {
  orderId: "订单号",
  amountCents: "金额（分）",
  tenantId: "租户",
  accountId: "账户",
  plan: "目标套餐",
};

/** 过期时间格式化；无效值返回空串 */
function formatExpiry(expiresAt: number): string {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return "";
  try {
    return new Date(expiresAt).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

export default function ConfirmCard({ confirm, submitted, dismissed, onConfirm, onDismiss }: Props) {
  if (dismissed) return null;

  const paramEntries = Object.entries(confirm.params ?? {}).filter(
    ([key]) => PARAM_LABELS[key] !== undefined,
  );

  return (
    <div className="confirm-card">
      <div className="confirm-card-title">
        <Tag color="orange">待确认操作</Tag>
        <span>{confirm.summary}</span>
      </div>
      {paramEntries.length > 0 ? (
        <ul className="confirm-card-params">
          {paramEntries.map(([key, value]) => (
            <li key={key}>
              {PARAM_LABELS[key]}：<strong>{String(value)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="confirm-card-meta">确认单 {confirm.proposalId}</div>
      {formatExpiry(confirm.expiresAt) ? (
        <div className="confirm-card-meta">有效期至 {formatExpiry(confirm.expiresAt)}</div>
      ) : null}
      <div className="confirm-card-actions">
        {submitted ? (
          <Tag color="processing">确认已提交，正在处理…</Tag>
        ) : (
          <>
            <Button
              type="primary"
              size="small"
              onClick={() => onConfirm(confirm)}
            >
              确认执行
            </Button>
            <Button size="small" onClick={() => onDismiss(confirm.proposalId)}>
              暂不执行
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
