import "./styles.css";

interface WorkbenchHeaderProps {
  sessionId: string;
}

export function WorkbenchHeader({ sessionId }: WorkbenchHeaderProps) {
  return (
    <header className="ask-header">
      <h1 className="ask-header__title">问数工作台</h1>
      <p className="ask-header__session">会话 {sessionId}</p>
    </header>
  );
}
