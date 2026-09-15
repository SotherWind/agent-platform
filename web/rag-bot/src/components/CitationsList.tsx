import { Collapse } from "antd";

export interface CitationRef {
  chunkId: string;
  documentId: string;
  text: string;
}

interface Props {
  citations: CitationRef[];
}

/** 引用来源：知识库片段，可折叠展示在回答下方 */
export default function CitationsList({ citations }: Props) {
  if (!citations.length) return null;

  return (
    <Collapse
      size="small"
      className="citations-collapse"
      items={[
        {
          key: "citations",
          label: `引用来源（${citations.length} 条知识库片段）`,
          children: (
            <ol className="citations-list">
              {citations.map((c, index) => (
                <li key={`${c.chunkId}-${index}`}>
                  <div className="citations-text">{c.text}</div>
                  <div className="citations-meta">
                    文档 {c.documentId} · 片段 {c.chunkId}
                  </div>
                </li>
              ))}
            </ol>
          ),
        },
      ]}
    />
  );
}
