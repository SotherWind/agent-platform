import type { UIMessage } from "ai";

export type ChartType = "bar" | "line" | "pie" | "table" | "scatter";

export interface ChartSpec {
  type: ChartType;
  title: string;
  option?: Record<string, unknown>;
  dataset?: {
    columns: string[];
    rows: unknown[][];
  };
}

export interface ClarificationOption {
  id: string;
  label: string;
}

export interface ClarificationRequest {
  reason: string;
  question: string;
  options?: ClarificationOption[];
}

export type PipelinePhase =
  | "started"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export interface PipelineStatusData {
  phase: PipelinePhase;
  activeNode?: string;
  seenNodes: string[];
}

export interface AnalyzeMeta {
  queryPath: string | null;
  confidence: number | null;
  requestId: string;
  traceId: string;
}

export interface AnalyzeResponseBody {
  finalAnswer: string;
  chartSpec?: ChartSpec;
  meta: AnalyzeMeta;
  needsClarification?: boolean;
  clarification?: ClarificationRequest;
}

export type AskDataDataParts = {
  pipeline: PipelineStatusData;
  chart: ChartSpec;
  clarification: ClarificationRequest;
  meta: AnalyzeMeta;
  error: {
    message: string;
    code?: string;
  };
};

export type AskDataUIMessage = UIMessage<never, AskDataDataParts>;

export const LOCAL_AUTH_HEADERS = {
  "x-subject-id": "user-dev",
  "x-tenant-id": "tenant-1",
} as const;

export const EXAMPLE_QUERIES = [
  "统计各城市的用户数量",
  "看一下订单状态的分布情况",
  "查一下北京用户上个月的订单总额",
  "最近一个月有哪些用户下过单",
] as const;
