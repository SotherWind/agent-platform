import "./styles.css";

interface UserBubbleProps {
  text: string;
}

export function UserBubble({ text }: UserBubbleProps) {
  return (
    <div className="ask-user">
      <p className="ask-user__bubble">{text}</p>
    </div>
  );
}
