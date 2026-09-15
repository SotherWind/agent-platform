import { useChat } from "@ai-sdk/react";
import { useMemo, useRef } from "react";
import { BiAnalyzeChatTransport } from "../api/BiAnalyzeChatTransport";
import { lastAnalyzeQuery } from "../model/message-text";
import { getOrCreateSessionId } from "../model/session";
import type { AskDataUIMessage, ClarificationOption } from "../model/types";

export function useAskDataChat(initialMessages: AskDataUIMessage[] = []) {
  const getSessionId = useRef(getOrCreateSessionId);
  const transport = useMemo(
    () => new BiAnalyzeChatTransport(getSessionId.current),
    [],
  );
  const chat = useChat<AskDataUIMessage>({
    transport,
    messages: initialMessages,
  });
  const lastQueryRef = useRef(lastAnalyzeQuery(initialMessages));

  const sendQuery = (text: string) => {
    const query = text.trim();
    if (!query) return;
    lastQueryRef.current = query;
    void chat.sendMessage({ text: query });
  };

  const sendClarification = (choice: ClarificationOption) => {
    const query = lastQueryRef.current || lastAnalyzeQuery(chat.messages);
    void chat.sendMessage(
      { text: choice.label },
      { body: { query, clarificationChoice: choice.id } },
    );
  };

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    stop: chat.stop,
    sendQuery,
    sendClarification,
  };
}
