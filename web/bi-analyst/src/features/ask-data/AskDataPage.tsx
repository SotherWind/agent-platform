import { App } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAskDataChat } from "./hooks/useAskDataChat";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { MessageList } from "./components/MessageList";
import { SessionRail } from "./components/SessionRail";
import { WorkbenchHeader } from "./components/WorkbenchHeader";
import type { AskDataUIMessage } from "./model/types";
import { EXAMPLE_QUERIES } from "./model/types";
import { getOrCreateSessionId, rotateSessionId } from "./model/session";
import {
  createThread,
  readActiveThreadId,
  readThreads,
  titleFromMessages,
  writeActiveThreadId,
  writeThreads,
  type ThreadRecord,
} from "./model/threads";
import "./ask-data-page.css";

function loadWorkspace(): { threads: ThreadRecord[]; activeId: string } {
  const stored = readThreads();
  const threads =
    stored.length > 0 ? stored : [createThread(getOrCreateSessionId())];
  const remembered = readActiveThreadId();
  const activeId =
    (remembered && threads.some((thread) => thread.id === remembered)
      ? remembered
      : threads[0]?.id) ?? getOrCreateSessionId();
  writeActiveThreadId(activeId);
  window.localStorage.setItem("bi-analyst.sessionId", activeId);
  return { threads, activeId };
}

export function AskDataPage() {
  const { message } = App.useApp();
  const health = useBackendHealth();
  const initial = useMemo(() => loadWorkspace(), []);
  const [threads, setThreads] = useState(initial.threads);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [sessionId, setSessionId] = useState(initial.activeId);

  const active = threads.find((thread) => thread.id === activeId) ?? threads[0];

  const activate = (id: string) => {
    setActiveId(id);
    setSessionId(id);
    writeActiveThreadId(id);
    window.localStorage.setItem("bi-analyst.sessionId", id);
  };

  return (
    <div className="ask-page">
      <SessionRail
        threads={threads}
        activeId={active?.id ?? activeId}
        sessionId={sessionId}
        health={health}
        onNew={() => {
          const nextId = rotateSessionId();
          const next = createThread(nextId);
          const updated = [next, ...threads].slice(0, 30);
          setThreads(updated);
          writeThreads(updated);
          activate(nextId);
        }}
        onSelect={activate}
      />
      {active ? (
        <AskDataChatPane
          key={active.id}
          thread={active}
          sessionId={sessionId}
          onError={(text) => message.error(text)}
          onPersist={(messages) => {
            setThreads((current) => {
              const title = titleFromMessages(messages);
              const prev = current.find((thread) => thread.id === active.id);
              if (
                prev &&
                prev.title === title &&
                prev.messages.length === messages.length &&
                prev.messages.at(-1)?.id === messages.at(-1)?.id
              ) {
                return current;
              }
              const next = current.map((thread) =>
                thread.id === active.id
                  ? {
                      ...thread,
                      title,
                      updatedAt: new Date().toISOString(),
                      messages,
                    }
                  : thread,
              );
              writeThreads(next);
              return next;
            });
          }}
        />
      ) : null}
    </div>
  );
}

function AskDataChatPane({
  thread,
  sessionId,
  onPersist,
  onError,
}: {
  thread: ThreadRecord;
  sessionId: string;
  onPersist: (messages: AskDataUIMessage[]) => void;
  onError: (text: string) => void;
}) {
  const chat = useAskDataChat(thread.messages);
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const busy = chat.status === "submitted" || chat.status === "streaming";

  useEffect(() => {
    if (busy) return;
    persistRef.current(chat.messages);
  }, [busy, chat.messages]);

  useEffect(() => {
    if (chat.error) errorRef.current(chat.error.message);
  }, [chat.error]);

  return (
    <section className="ask-main">
      <WorkbenchHeader sessionId={sessionId} />
      <div className="ask-main__body">
        {chat.messages.length === 0 ? (
          <EmptyState examples={EXAMPLE_QUERIES} onPick={chat.sendQuery} />
        ) : (
          <MessageList
            messages={chat.messages}
            clarificationDisabled={busy}
            onClarification={chat.sendClarification}
          />
        )}
      </div>
      <Composer busy={busy} onSend={chat.sendQuery} onStop={() => void chat.stop()} />
    </section>
  );
}
