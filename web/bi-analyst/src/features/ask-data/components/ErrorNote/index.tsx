import "./styles.css";

interface ErrorNoteProps {
  message: string;
}

export function ErrorNote({ message }: ErrorNoteProps) {
  return (
    <p className="ask-error" role="alert">
      {message}
    </p>
  );
}
