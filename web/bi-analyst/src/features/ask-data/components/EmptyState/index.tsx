import "./styles.css";

interface EmptyStateProps {
  examples: readonly string[];
  onPick: (query: string) => void;
}

export function EmptyState({ examples, onPick }: EmptyStateProps) {
  return (
    <div className="ask-empty">
      <h2 className="ask-empty__title">用一句话问数据</h2>
      <p className="ask-empty__copy">系统会检索表结构、生成只读 SQL，并给出图表。</p>
      <div className="ask-empty__examples">
        {examples.map((query) => (
          <button
            key={query}
            type="button"
            className="ask-empty__chip"
            onClick={() => onPick(query)}
          >
            {query}
          </button>
        ))}
      </div>
    </div>
  );
}
