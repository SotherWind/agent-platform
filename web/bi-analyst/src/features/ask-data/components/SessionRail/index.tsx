import type { BackendHealth } from "../../hooks/useBackendHealth";
import type { ThreadRecord } from "../../model/threads";
import "./styles.css";

interface SessionRailProps {
  threads: ThreadRecord[];
  activeId: string;
  sessionId: string;
  health: BackendHealth;
  onNew: () => void;
  onSelect: (id: string) => void;
}

export function SessionRail({
  threads,
  activeId,
  sessionId,
  health,
  onNew,
  onSelect,
}: SessionRailProps) {
  const statusLabel = health.checking
    ? "正在检测后端"
    : health.ok
      ? "后端已连接"
      : "后端未连接";

  return (
    <aside className="ask-rail">
      <div className="ask-rail__brand">
        <span className="ask-rail__mark" aria-hidden="true" />
        <span className="ask-rail__name">问数</span>
      </div>

      <div className="ask-rail__section">
        <p className="ask-rail__label">会话</p>
        <button type="button" className="ask-rail__new" onClick={onNew}>
          新会话
        </button>
        <ul className="ask-rail__list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className={
                  thread.id === activeId
                    ? "ask-rail__item ask-rail__item--active"
                    : "ask-rail__item"
                }
                onClick={() => onSelect(thread.id)}
              >
                {thread.title}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="ask-rail__footer">
        <p className="ask-rail__health">
          <span
            className={
              health.ok ? "ask-rail__dot ask-rail__dot--ok" : "ask-rail__dot"
            }
            aria-hidden="true"
          />
          {statusLabel}
        </p>
        <p className="ask-rail__session">{sessionId}</p>
      </div>
    </aside>
  );
}
