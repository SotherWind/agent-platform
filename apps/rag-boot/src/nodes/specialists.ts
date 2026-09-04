/**
 * T1.3 专家注册表
 *
 * 依据 Diffco 阶段 3：每个专家持有约 800 token 的聚焦提示词（而非 4000）、
 * **仅限本域的工具子集**（账单专家能读发票、提议套餐变更，但不能改集成配置）、
 * 独立评测集、独立提示词版本轨。
 *
 * 工具边界这件事务必在代码里，不在提示词里（清单 264 行）：
 * 「越界调用必然被代码拦截（不依赖模型自觉）」。
 *
 * 关于何时拆多智能体：清单末段引 Diffco 原话「架构变成多智能体是挣来的，不是选来的」，
 * 建议先用单专家跑通 P0-P7，用评测集证明单 Agent 撞墙后再拆。
 * 注册表在这里是**预留的形状**，默认每个类别一个专家，但合并执行，不做并行子进程。
 */
import type { ToolRequest } from "../schema";

export interface SpecialistDefinition {
  category: string;
  /** 本专家独立提示词的路径标识（清单 272 行注册表形状），对应 prompts/specialists.ts */
  promptPath: string;
  /** 仅限本域的工具子集——爆炸半径由这份清单限死 */
  toolNames: string[];
  /** 独立评测集路径（T7.1） */
  evalSetPath: string;
  /** 冲突消解优先级，数字越大越优先（T1.4） */
  priority: number;
}

export const SPECIALIST_REGISTRY: Record<string, SpecialistDefinition> = {
  billing: {
    category: "billing",
    promptPath: "prompts/specialists#billing",
    // 能读账单、提议套餐变更；不能改集成配置
    toolNames: ["get_billing_summary", "propose_plan_change", "create_ticket"],
    evalSetPath: "src/eval/fixtures/billing.jsonl",
    priority: 3,
  },
  integration: {
    category: "integration",
    promptPath: "prompts/specialists#integration",
    // 能读集成配置、提议重置凭证；不能动账单
    toolNames: ["get_integration_status", "propose_credential_reset", "create_ticket"],
    evalSetPath: "src/eval/fixtures/integration.jsonl",
    priority: 2,
  },
  account: {
    category: "account",
    promptPath: "prompts/specialists#account",
    toolNames: ["get_account_profile", "create_ticket"],
    evalSetPath: "src/eval/fixtures/account.jsonl",
    priority: 2,
  },
  technical: {
    category: "technical",
    promptPath: "prompts/specialists#technical",
    toolNames: ["get_service_status", "create_ticket"],
    evalSetPath: "src/eval/fixtures/technical.jsonl",
    priority: 4,
  },
  order: {
    category: "order",
    promptPath: "prompts/specialists#order",
    toolNames: ["get_order_status", "propose_refund", "create_ticket"],
    evalSetPath: "src/eval/fixtures/order.jsonl",
    priority: 3,
  },
  general: {
    category: "general",
    promptPath: "prompts/specialists#general",
    // 通用专家只有建单能力，没有业务读工具
    toolNames: ["create_ticket"],
    evalSetPath: "src/eval/fixtures/general.jsonl",
    priority: 1,
  },
};

/** 取专家定义，未知类别回落到 general（而不是报错中断流程） */
export function getSpecialist(category: string): SpecialistDefinition {
  return SPECIALIST_REGISTRY[category] ?? SPECIALIST_REGISTRY.general;
}

export interface ToolBoundaryResult {
  allowed: ToolRequest[];
  /** 越界被拒的请求：记录违规，供审计与评测 */
  rejected: Array<ToolRequest & { reason: string }>;
}

/**
 * 工具边界校验：执行前的硬闸门。
 *
 * 专家可以**请求**任何工具，但只有落在自己清单里的才会被放行。
 * 被拒的请求不会静默丢弃——会记进 rejected，写进审计与专家输出，
 * 这样评测集能统计「模型越界率」，作为提示词质量的一个信号。
 */
export function enforceToolBoundary(
  requests: ToolRequest[],
  category: string,
): ToolBoundaryResult {
  const specialist = getSpecialist(category);
  const allowed: ToolRequest[] = [];
  const rejected: Array<ToolRequest & { reason: string }> = [];

  for (const req of requests) {
    if (specialist.toolNames.includes(req.name)) {
      allowed.push(req);
    } else {
      rejected.push({
        ...req,
        reason: `tool "${req.name}" is not in the allowlist of specialist "${category}"`,
      });
    }
  }

  return { allowed, rejected };
}

/** 冲突消解优先级：数字越大越可信（T1.4） */
export function priorityOf(category: string): number {
  return getSpecialist(category).priority;
}
