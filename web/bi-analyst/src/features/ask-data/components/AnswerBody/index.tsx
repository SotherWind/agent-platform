import "./styles.css";

interface AnswerBodyProps {
  text: string;
}

export function AnswerBody({ text }: AnswerBodyProps) {
  if (!text.trim()) return null;
  return <p className="ask-answer">{text}</p>;
}
