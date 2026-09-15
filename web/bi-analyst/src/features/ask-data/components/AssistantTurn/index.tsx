import type { AskDataUIMessage, ClarificationOption } from "../../model/types";
import { AnswerBody } from "../AnswerBody";
import { ChartPanel } from "../ChartPanel";
import { ClarificationBar } from "../ClarificationBar";
import { ErrorNote } from "../ErrorNote";
import { PipelineStatus } from "../PipelineStatus";
import "./styles.css";

interface AssistantTurnProps {
  parts: AskDataUIMessage["parts"];
  clarificationDisabled?: boolean;
  onClarification: (choice: ClarificationOption) => void;
}

export function AssistantTurn({
  parts,
  clarificationDisabled,
  onClarification,
}: AssistantTurnProps) {
  const pipeline = parts.find((part) => part.type === "data-pipeline");
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const chart = parts.find((part) => part.type === "data-chart");
  const clarification = parts.find((part) => part.type === "data-clarification");
  const failure = parts.find((part) => part.type === "data-error");

  return (
    <div className="ask-assistant">
      {pipeline ? <PipelineStatus pipeline={pipeline.data} /> : null}
      {failure ? (
        <ErrorNote message={text || failure.data.message} />
      ) : (
        <AnswerBody text={text} />
      )}
      {chart ? <ChartPanel spec={chart.data} /> : null}
      {clarification ? (
        <ClarificationBar
          clarification={clarification.data}
          disabled={clarificationDisabled}
          onSelect={onClarification}
        />
      ) : null}
    </div>
  );
}
