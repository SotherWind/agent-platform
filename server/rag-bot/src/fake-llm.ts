/**
 * 演示模式 LLM：USE_FAKE_LLM=true 时注入图的三档，全部走固定话术，零外呼。
 *
 * 各 stage 的 JSON 形状与 rag-boot 节点的解析契约一致
 * （triage/specialist/review 参见 apps/rag-boot/src/nodes/* 与 eval/fixtures）。
 *
 * 类型说明：这里用结构化局部类型对齐 rag-boot 的 Llm 接口
 * （apps/rag-boot/src/llm/types.ts），避免对包内非公开导出路径的依赖；
 * 结构一致即可赋给 BuildGraphConfig.llms。
 */

export type ModelTier = "simple" | "small" | "large";

export interface LlmRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  stage?: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  tier: ModelTier;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  degraded?: boolean;
  fallbackFrom?: string;
  fallbackExhausted?: boolean;
}

export interface LlmLike {
  readonly model: string;
  readonly tier: ModelTier;
  invoke(req: LlmRequest): Promise<LlmResponse>;
}

const REPLY_TRIAGE = JSON.stringify({
  categories: ["general"],
  urgency: "normal",
  likelyNeedsHuman: false,
  needsRealtimeData: false,
});

const REPLY_SPECIALIST = JSON.stringify({
  status: "resolved",
  answer: "（演示模式）已收到你的问题，这是演示模式的固定回答。",
  citations: [],
});

/**
 * 演示模式的确认流脚本：提到退款（或用户回传裸确认指令）时，订单专家请求
 * propose_refund，让 T5.3 的「propose → 用户点确认 → 确认执行」在零外呼模式下
 * 可以完整走通。分诊要给 ["order"]（propose_refund 只在订单专家的允许清单里）。
 *
 * 注意：server 始终传 history: []，确认轮的 specialist 只看得到「确认」两个字，
 * 所以裸确认指令必须在这里显式映射回退款工具，否则确认流程无法闭合。
 */
const REFUND_INTENT = /退款|退货|确认单|prop-/;
const BARE_CONFIRM = /^【用户问题】\s*(确认|确认执行|同意|好的，确认)[。！!。\s]*$/m;

function demoTriage(prompt: string): string {
  if (REFUND_INTENT.test(prompt) || BARE_CONFIRM.test(prompt)) {
    return JSON.stringify({
      categories: ["order"],
      urgency: "normal",
      likelyNeedsHuman: false,
      needsRealtimeData: false,
    });
  }
  return REPLY_TRIAGE;
}

function demoSpecialist(prompt: string): string {
  // 知识上下文里也可能出现「退款」字样，裸确认的判定只看【用户问题】行
  const isConfirm = BARE_CONFIRM.test(prompt);
  if (REFUND_INTENT.test(prompt) || isConfirm) {
    return JSON.stringify({
      status: "needsOrchestrator",
      partialAnswer: "可以为你申请退款",
      toolRequests: [
        { name: "propose_refund", args: { orderId: "order-demo-refund", amountCents: 9900 } },
      ],
    });
  }
  return REPLY_SPECIALIST;
}

const REPLY_GENERATE =
  "（演示模式）当前服务运行在 USE_FAKE_LLM=true 的演示模式，未接入真实大模型。" +
  "请在 server/rag-bot/.env 中配置 MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME 后重启，即可获得真实回答。";

const REPLY_REVIEW = JSON.stringify({ passed: true, violations: [] });

function replyFor(req: LlmRequest): string {
  switch (req.stage) {
    case "triage":
      return demoTriage(req.prompt);
    case "specialist":
      return demoSpecialist(req.prompt);
    case "review":
      return REPLY_REVIEW;
    case "rewrite":
      return "客服咨询";
    case "generate":
      return REPLY_GENERATE;
    default:
      return REPLY_GENERATE;
  }
}

/** 极简 fake：不做 token 精算，用量按字符长度粗估（演示模式不参与成本核算） */
export function createDemoLlm(tier: ModelTier = "small"): LlmLike {
  return {
    model: "demo-fake-llm",
    tier,
    async invoke(req: LlmRequest): Promise<LlmResponse> {
      const text = replyFor(req);
      const promptTokens = Math.ceil(req.prompt.length / 2);
      const completionTokens = Math.ceil(text.length / 2);
      return {
        text,
        model: "demo-fake-llm",
        tier,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    },
  };
}

/** 注入三档演示模型（BuildGraphConfig.llms 形状） */
export function demoLlms(): { simple: LlmLike[]; small: LlmLike[]; large: LlmLike[] } {
  return {
    simple: [createDemoLlm("simple")],
    small: [createDemoLlm("small")],
    large: [createDemoLlm("large")],
  };
}
