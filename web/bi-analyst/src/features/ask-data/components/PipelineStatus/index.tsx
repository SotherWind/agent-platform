import { PIPELINE_STEPS, stepStates } from "../../model/pipeline";
import type { PipelineStatusData } from "../../model/types";
import "./styles.css";

interface PipelineStatusProps {
  pipeline: PipelineStatusData;
}

export function PipelineStatus({ pipeline }: PipelineStatusProps) {
  const states = stepStates(pipeline);
  return (
    <ol className="ask-pipe" aria-label="分析进度">
      {PIPELINE_STEPS.map((step, index) => (
        <li
          key={step.id}
          className={`ask-pipe__step ask-pipe__step--${states[index] ?? "pending"}`}
        >
          <span>{step.label}</span>
          {index < PIPELINE_STEPS.length - 1 ? (
            <span className="ask-pipe__arrow" aria-hidden="true">
              →
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
