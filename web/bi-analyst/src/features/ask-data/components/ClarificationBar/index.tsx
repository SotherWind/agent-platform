import type { ClarificationOption, ClarificationRequest } from "../../model/types";
import "./styles.css";

interface ClarificationBarProps {
  clarification: ClarificationRequest;
  disabled?: boolean;
  onSelect: (choice: ClarificationOption) => void;
}

export function ClarificationBar({
  clarification,
  disabled,
  onSelect,
}: ClarificationBarProps) {
  return (
    <div className="ask-clarify">
      <p className="ask-clarify__question">{clarification.question}</p>
      <div className="ask-clarify__options">
        {(clarification.options ?? []).map((option) => (
          <button
            key={option.id}
            type="button"
            className="ask-clarify__option"
            disabled={disabled}
            onClick={() => onSelect(option)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
