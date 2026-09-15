import { useEffect, useRef } from "react";
import { messageText } from "../../model/message-text";
import type { AskDataUIMessage, ClarificationOption } from "../../model/types";
import { AssistantTurn } from "../AssistantTurn";
import { UserBubble } from "../UserBubble";
import "./styles.css";

interface MessageListProps {
  messages: AskDataUIMessage[];
  clarificationDisabled?: boolean;
  onClarification: (choice: ClarificationOption) => void;
}

export function MessageList({
  messages,
  clarificationDisabled,
  onClarification,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div className="ask-messages">
      {messages.map((message) => {
        if (message.role === "user") {
          return <UserBubble key={message.id} text={messageText(message)} />;
        }
        if (message.role === "assistant") {
          return (
            <AssistantTurn
              key={message.id}
              parts={message.parts}
              clarificationDisabled={clarificationDisabled}
              onClarification={onClarification}
            />
          );
        }
        return null;
      })}
      <div ref={endRef} />
    </div>
  );
}
