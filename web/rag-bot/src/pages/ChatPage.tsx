import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App as AntdApp, Avatar, Button, Input, Space, Tag, Tooltip, Typography } from "antd";
import { getThreadId, getToken, getUsername, newThreadId } from "../api/auth";
import TypewriterText from "../components/TypewriterText";
import ConfirmCard, { type ConfirmData } from "../components/ConfirmCard";
import CitationsList, { type CitationRef } from "../components/CitationsList";
import TicketsPage from "./TicketsPage";

/** 从 UIMessage 的 parts 里取指定 data part 的载荷 */
function extractDataParts<T>(message: UIMessage, type: string): T[] {
  return message.parts
    .filter((part) => part.type === type)
    .map((part) => (part as { data: T }).data);
}

/** 从 UIMessage 提取纯文本。若消息带 data-replace part（安全策略替换），只取最后一个 text part */
function messageText(message: UIMessage): string {
  const parts = message.parts ?? [];
  const hasReplace = parts.some((part) => part.type === "data-replace");
  if (hasReplace) {
    const textParts = parts.filter((part) => part.type === "text");
    const last = textParts[textParts.length - 1];
    return last && last.type === "text" ? last.text : "";
  }
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** 消息是否被安全策略替换过（用于展示提示标签） */
function wasReplaced(message: UIMessage): boolean {
  return message.parts.some((part) => part.type === "data-replace");
}

interface Props {
  onLogout: () => void;
}

export default function ChatPage({ onLogout }: Props) {
  const { message: antdMessage } = AntdApp.useApp();
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "tickets">("chat");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 确认流：已提交确认的 proposal（按钮变已提交态）、用户主动放弃的 proposal
  const [submittedProposals, setSubmittedProposals] = useState<Set<string>>(new Set());
  const [dismissedProposals, setDismissedProposals] = useState<Set<string>>(new Set());

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => ({ Authorization: `Bearer ${getToken() ?? ""}` }),
        body: () => ({ threadId: getThreadId(), messageId: crypto.randomUUID() }),
      }),
    [],
  );

  const { messages, sendMessage, status, error, stop, setMessages } = useChat({ transport });

  // 确认流操作：把确认单字段随消息 body 透传给服务端（图内 ProposalService 校验令牌）
  const handleConfirm = useCallback(
    (confirm: ConfirmData) => {
      setSubmittedProposals((prev) => new Set(prev).add(confirm.proposalId));
      antdMessage.success("确认已发送");
      void sendMessage(
        { text: "确认执行" },
        {
          body: {
            threadId: getThreadId(),
            messageId: crypto.randomUUID(),
            confirmationProposalId: confirm.proposalId,
            confirmationToken: confirm.confirmToken,
          },
        },
      );
    },
    [antdMessage, sendMessage],
  );
  const handleDismiss = useCallback((proposalId: string) => {
    setDismissedProposals((prev) => new Set(prev).add(proposalId));
  }, []);

  const busy = status === "submitted" || status === "streaming";

  // 终审尾巴提示：打字机已追平但流尚未结束（LLM 终审中），持续 1.5s 才显示，避免闪烁
  const [reviewing, setReviewing] = useState(false);
  const reviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCaughtUp = useCallback(
    (caughtUp: boolean) => {
      if (reviewTimerRef.current) {
        clearTimeout(reviewTimerRef.current);
        reviewTimerRef.current = null;
      }
      if (caughtUp && status === "streaming") {
        reviewTimerRef.current = setTimeout(() => setReviewing(true), 1500);
      } else {
        setReviewing(false);
      }
    },
    [status],
  );
  useEffect(() => {
    if (status !== "streaming") {
      if (reviewTimerRef.current) clearTimeout(reviewTimerRef.current);
      setReviewing(false);
    }
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    // 登录态失效（token 过期 / 服务重启）：清空本地登录态，回到登录页
    if (error && /401|未认证|凭证/.test(error.message)) {
      antdMessage.warning("登录已失效，请重新登录");
      onLogout();
    }
  }, [error, antdMessage, onLogout]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    await sendMessage({ text });
  };

  const handleNewConversation = () => {
    newThreadId();
    setMessages([]);
    setInput("");
    antdMessage.success("已开启新会话");
  };

  return (
    <div className="chat-page">
      <header className="chat-header">
        <Space size="small">
          <Avatar style={{ backgroundColor: "#2563eb" }}>客</Avatar>
          <Typography.Title level={4} style={{ margin: 0 }}>
            智能客服
          </Typography.Title>
        </Space>
        <Space size="small">
          <Tag color="blue">{getUsername()}</Tag>
          {view === "chat" ? (
            <Button onClick={() => setView("tickets")}>我的工单</Button>
          ) : (
            <Button type="primary" ghost onClick={() => setView("chat")}>
              返回对话
            </Button>
          )}
          <Button onClick={handleNewConversation}>新会话</Button>
          <Button type="text" onClick={onLogout}>
            退出登录
          </Button>
        </Space>
      </header>

      {view === "tickets" ? (
        <TicketsPage onBack={() => setView("chat")} />
      ) : (
        <>
      <main className="chat-body">
        {messages.length === 0 && !error ? (
          <div className="chat-empty">
            <Typography.Title level={4} type="secondary">
              你好，我是优选商城智能客服
            </Typography.Title>
            <Typography.Text type="secondary">
              可以咨询退货、退款、换货、物流、发票、价保、优惠券等问题
            </Typography.Text>
          </div>
        ) : null}

        {messages.map((message, index) => {
          const text = messageText(message);
          const isUser = message.role === "user";
          const isStreamingLast =
            !isUser &&
            index === messages.length - 1 &&
            (status === "submitted" || status === "streaming");
          const confirmations = isUser ? [] : extractDataParts<ConfirmData>(message, "data-confirm");
          const citations = isUser
            ? []
            : extractDataParts<{ citations: CitationRef[] }>(message, "data-citations")[0]?.citations ?? [];
          const ticketIds = isUser ? [] : extractDataParts<{ ticketId: string }>(message, "data-ticket").map((t) => t.ticketId);
          return (
            <div key={message.id} className={`chat-row ${isUser ? "chat-row-user" : "chat-row-assistant"}`}>
              {!isUser ? <Avatar style={{ backgroundColor: "#2563eb", flexShrink: 0 }}>客</Avatar> : null}
              <div className={`chat-bubble ${isUser ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
                {wasReplaced(message) ? (
                  <Tag color="orange" style={{ marginBottom: 6 }}>
                    已按安全策略调整本条回复
                  </Tag>
                ) : null}
                {isUser ? (
                  <span>{text}</span>
                ) : !text ? (
                  <span>…</span>
                ) : isStreamingLast ? (
                  <TypewriterText text={text} active={status === "streaming"} onCaughtUpChange={handleCaughtUp} />
                ) : (
                  <span>{text}</span>
                )}
                {ticketIds.map((ticketId) => (
                  <div key={ticketId} style={{ marginTop: 8 }}>
                    <Tag color="blue">已创建工单 {ticketId.slice(0, 8)}</Tag>
                  </div>
                ))}
                {!isUser && citations.length > 0 ? (
                  <div className="bubble-attachments">
                    <CitationsList citations={citations} />
                  </div>
                ) : null}
                {!isUser && confirmations.length > 0 ? (
                  <div className="bubble-attachments">
                    {confirmations.map((confirm) => (
                      <ConfirmCard
                        key={confirm.proposalId}
                        confirm={confirm}
                        submitted={submittedProposals.has(confirm.proposalId)}
                        dismissed={dismissedProposals.has(confirm.proposalId)}
                        onConfirm={handleConfirm}
                        onDismiss={handleDismiss}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
              {reviewing && isStreamingLast ? <span className="review-hint">正在审查回复安全…</span> : null}
            </div>
          );
        })}

        {status === "submitted" ? (
          <div className="chat-row chat-row-assistant">
            <Avatar style={{ backgroundColor: "#2563eb", flexShrink: 0 }}>客</Avatar>
            <div className="chat-bubble chat-bubble-assistant typing">
              正在思考
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        ) : null}

        {error ? (
          <Alert
            type="error"
            showIcon
            message="请求失败"
            description={
              <Space direction="vertical">
                <span>{error.message}</span>
                <Button size="small" onClick={handleNewConversation}>
                  重置会话重试
                </Button>
              </Space>
            }
          />
        ) : null}

        <div ref={bottomRef} />
      </main>

      <footer className="chat-input">
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="large"
            placeholder="请输入你的问题…"
            value={input}
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
            onPressEnter={() => void handleSend()}
          />
          {busy ? (
            <Tooltip title="停止生成">
              <Button size="large" danger onClick={stop}>
                停止
              </Button>
            </Tooltip>
          ) : (
            <Button type="primary" size="large" onClick={() => void handleSend()} disabled={!input.trim()}>
              发送
            </Button>
          )}
        </Space.Compact>
      </footer>
        </>
      )}
    </div>
  );
}
