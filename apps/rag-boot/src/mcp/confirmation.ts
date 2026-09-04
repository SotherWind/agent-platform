/**
 * T3.4 ↔ T5.3 桥接：确认状态（ActionProposal）走 MRTR 而不是长连接反向请求。
 *
 * 场景：Agent 通过 MCP 暴露给外部系统（CRM、工单平台）时，写动作的三段确认
 * 不能用服务端反向推送——MCP 2026-07-28 规范已取消该能力。取而代之的是：
 *   1. 工具调用触发写动作 → 返回 input_required，requestState 携带确认状态
 *      （proposalId + confirmToken + expiresAt）；
 *   2. 用户确认后客户端收集 inputResponses 回带 requestState 重发；
 *   3. 服务端从 requestState 解出确认状态，走 T5.3 的确定性 confirm 路径。
 *
 * 安全说明：requestState 是服务端签发、客户端原样回带的不透明串，语义等同令牌
 * ——与 T5.3 发给用户的 confirmToken 同等级，传输必须走 TLS，且不得写入日志。
 * 状态完全在 requestState 里，服务端不持有连接（任意实例可响应恢复请求）。
 */
import type { ActionProposal } from "../actions/proposal";
import type { McpInputResumeRequest, McpToolCallResponse } from "./stateless";

/** requestState 线格式：版本前缀 + base64url(JSON)。版本前缀供将来改格式时兼容。 */
const REQUEST_STATE_PREFIX = "v1:";

interface ConfirmationState {
  proposalId: string;
  confirmToken: string;
  expiresAt: number;
}

/** T5.3 确认状态 → MRTR input_required 响应 */
export function proposalToInputRequired(proposal: ActionProposal): McpToolCallResponse {
  return {
    status: "input_required",
    inputRequests: [
      {
        id: "confirm",
        prompt: proposal.summary,
        type: "choice",
        options: ["confirm", "cancel"],
      },
    ],
    requestState: encodeConfirmationState({
      proposalId: proposal.id,
      confirmToken: proposal.confirmToken,
      expiresAt: proposal.expiresAt,
    }),
  };
}

/** MRTR resume 请求 → T5.3 confirm 入参（confirmToken 原样回带，身份校验交给 confirm 段） */
export function resumeToConfirmation(request: McpInputResumeRequest): {
  proposalId: string;
  confirmToken: string;
  expiresAt: number;
  confirmed: boolean;
} {
  const state = decodeConfirmationState(request.requestState);
  const answer = request.inputResponses["confirm"] ?? "";
  return {
    proposalId: state.proposalId,
    confirmToken: state.confirmToken,
    expiresAt: state.expiresAt,
    confirmed: answer === "confirm",
  };
}

function encodeConfirmationState(state: ConfirmationState): string {
  return REQUEST_STATE_PREFIX + Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeConfirmationState(requestState: string): ConfirmationState {
  if (!requestState.startsWith(REQUEST_STATE_PREFIX)) {
    throw new Error(`unrecognized requestState format: expected "${REQUEST_STATE_PREFIX}" prefix`);
  }
  const json = Buffer.from(requestState.slice(REQUEST_STATE_PREFIX.length), "base64url").toString("utf8");
  const parsed = JSON.parse(json) as ConfirmationState;
  if (!parsed.proposalId || !parsed.confirmToken || typeof parsed.expiresAt !== "number") {
    throw new Error("requestState is not a confirmation state");
  }
  return parsed;
}
