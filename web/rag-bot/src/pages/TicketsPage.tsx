import { useCallback, useEffect, useState } from "react";
import { Button, Input, Rate, Table, Tag, Typography } from "antd";
import { getToken } from "../api/auth";

/** GET /api/tickets 返回的 DTO（服务端已剥离 handoff/history 等内部字段） */
export interface TicketDto {
  id: string;
  threadId: string;
  category: string;
  subject: string;
  status: "open" | "assigned" | "pending" | "resolved" | "closed";
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  resolution: "agent-resolved" | "human-resolved" | "abandoned" | null;
  humanInvolved: boolean;
  rating: number | null;
}

const STATUS_TAG: Record<TicketDto["status"], { color: string; label: string }> = {
  open: { color: "processing", label: "待处理" },
  assigned: { color: "cyan", label: "已受理" },
  pending: { color: "orange", label: "等待中" },
  resolved: { color: "success", label: "已解决" },
  closed: { color: "default", label: "已关闭" },
};

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ts);
  }
}

/** 行内评价表单：一次评价，提交后锁定 */
function RatingForm({ ticket, onRated }: { ticket: TicketDto; onRated: (id: string, rating: number) => void }) {
  const [rating, setRating] = useState<number>(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ticket.rating !== null) {
    const stars = ticket.rating;
    return (
      <Typography.Text type="secondary">
        已评价：{stars} 星{stars ? " ⭐".repeat(stars) : ""}
      </Typography.Text>
    );
  }

  const submit = async () => {
    if (rating < 1) {
      setError("请先选择星级");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/tickets/${ticket.id}/rating`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${getToken() ?? ""}` },
        body: JSON.stringify({ rating, ...(comment.trim() ? { comment: comment.trim() } : {}) }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `提交失败（${response.status}）`);
        return;
      }
      const payload = (await response.json()) as { ticket: TicketDto };
      onRated(ticket.id, payload.ticket.rating ?? rating);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rating-form">
      <div className="rating-form-row">
        <Rate value={rating} onChange={setRating} />
        {ticket.humanInvolved ? <Tag color="blue">本单有人工参与</Tag> : null}
      </div>
      <Input.TextArea
        placeholder="补充评价（可选，500 字以内）"
        maxLength={500}
        rows={2}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <Button type="primary" size="small" loading={submitting} onClick={() => void submit()}>
        提交评价
      </Button>
      <Typography.Text type="secondary" className="rating-form-hint">
        评价用于改进服务质量（关联会话与问题分类）
      </Typography.Text>
    </div>
  );
}

interface Props {
  onBack: () => void;
}

export default function TicketsPage({ onBack }: Props) {
  const [tickets, setTickets] = useState<TicketDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/tickets", {
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (response.status === 401) {
        setError("登录已失效，请重新登录");
        return;
      }
      if (!response.ok) {
        setError(`加载失败（${response.status}）`);
        return;
      }
      const payload = (await response.json()) as { tickets?: TicketDto[] };
      setTickets(payload.tickets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  const handleRated = useCallback((id: string, rating: number) => {
    setTickets((prev) =>
      prev?.map((t) => (t.id === id ? { ...t, rating } : t)) ?? prev,
    );
  }, []);

  return (
    <div className="tickets-page">
      <div className="tickets-toolbar">
        <Button onClick={onBack}>← 返回对话</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          我的工单
        </Typography.Title>
        <Button onClick={() => void fetchTickets()} loading={loading}>
          刷新
        </Button>
      </div>

      {error ? (
        <Typography.Paragraph type="danger">{error}</Typography.Paragraph>
      ) : null}

      <Table<TicketDto>
        rowKey="id"
        size="middle"
        loading={loading && tickets === null}
        dataSource={tickets ?? []}
        locale={{ emptyText: "当前租户还没有工单。回复「转人工」或在对话中触发升级即可创建。" }}
        expandable={{
          expandedRowRender: (ticket) => (
            <div className="ticket-detail">
              <Typography.Text type="secondary">完整工单号：</Typography.Text>
              <Typography.Text code copyable={{ text: ticket.id }}>
                {ticket.id}
              </Typography.Text>
              <div className="ticket-detail-meta">
                会话 {ticket.threadId} · 最近更新 {formatTime(ticket.updatedAt)}
                {ticket.closedAt ? ` · 关闭于 ${formatTime(ticket.closedAt)}` : ""}
              </div>
              <RatingForm ticket={ticket} onRated={handleRated} />
            </div>
          ),
        }}
        columns={[
          {
            title: "工单号",
            dataIndex: "id",
            width: 110,
            render: (id: string) => (
              <Typography.Text code>{id.slice(0, 8)}</Typography.Text>
            ),
          },
          { title: "主题", dataIndex: "subject", ellipsis: true },
          { title: "分类", dataIndex: "category", width: 90 },
          {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (status: TicketDto["status"]) => {
              const meta = STATUS_TAG[status] ?? { color: "default", label: status };
              return <Tag color={meta.color}>{meta.label}</Tag>;
            },
          },
          {
            title: "评价",
            dataIndex: "rating",
            width: 100,
            render: (rating: number | null) =>
              rating !== null ? <Rate disabled value={rating} style={{ fontSize: 12 }} /> : <Tag>未评价</Tag>,
          },
          {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 170,
            render: (ts: number) => formatTime(ts),
          },
        ]}
      />
    </div>
  );
}
