import type { PipelineStatusData } from "./types";

export const PIPELINE_STEPS = [
  { id: "understand", label: "解析问题", nodes: ["planner", "datasourceRouter", "queryPathRouter", "metricResolver", "clarify"] },
  { id: "schema", label: "检索表结构", nodes: ["schemaRag"] },
  { id: "sql", label: "生成 SQL", nodes: ["sqlGenerator", "retry"] },
  { id: "execute", label: "执行查询", nodes: ["codeInterpreter"] },
  { id: "chart", label: "生成图表", nodes: ["chartFormatter"] },
] as const;

export type PipelineStepState = "done" | "active" | "pending";

export function stepStates(pipeline: PipelineStatusData): PipelineStepState[] {
  if (pipeline.phase === "completed") {
    return PIPELINE_STEPS.map(() => "done");
  }

  const current = currentStepIndex(pipeline);
  return PIPELINE_STEPS.map((_, index) => {
    if (current < 0) {
      return index === 0 && pipeline.phase !== "error" ? "active" : "pending";
    }
    if (index < current) return "done";
    if (index === current) return "active";
    return "pending";
  });
}

export function nextPipeline(
  previous: PipelineStatusData | undefined,
  patch: Partial<PipelineStatusData> & { node?: string },
): PipelineStatusData {
  const seenNodes = [...(previous?.seenNodes ?? [])];
  if (patch.node && !seenNodes.includes(patch.node)) {
    seenNodes.push(patch.node);
  }
  return {
    phase: patch.phase ?? previous?.phase ?? "running",
    activeNode: patch.node ?? patch.activeNode ?? previous?.activeNode,
    seenNodes,
  };
}

function currentStepIndex(pipeline: PipelineStatusData): number {
  if (pipeline.activeNode) {
    const byActive = PIPELINE_STEPS.findIndex((step) =>
      (step.nodes as readonly string[]).includes(pipeline.activeNode!),
    );
    if (byActive >= 0) return byActive;
  }
  return PIPELINE_STEPS.reduce((last, step, index) => {
    const hit = step.nodes.some((node) => pipeline.seenNodes.includes(node));
    return hit ? index : last;
  }, -1);
}
