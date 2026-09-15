/**
 * 业务工具集
 *
 * 存在的目的是让 T3.1（读写分级）、T3.2（幂等）、T3.3（动态数据强制取数）
 * 有**真实的可执行对象**可测，而不是只测抽象契约。
 *
 * 工具本体只做参数解析与返回，副作用（扣款、发通知、建单）由注入的 `Backend`
 * 承担——这样单测能注入 fake backend 断言「副作用只发生了一次」。
 *
 * 命名约定：
 * - `get_*`      → read，可直接调用
 * - `propose_*`  → write，必须经 T5.3 确认，且只产出提议
 * - `create_*`   → write，建单类，带幂等键
 */
import { z } from "zod/v4";
import type { AgentTool } from "./contract";

/** 业务后端：所有真实副作用都在这里，便于注入 fake 做断言 */
export interface Backend {
  getOrderStatus(orderId: string, tenantId: string): Promise<{ status: string; updatedAt: number }>;
  getBillingSummary(accountId: string, tenantId: string): Promise<{ amountCents: number; period: string }>;
  getIntegrationStatus(accountId: string, tenantId: string): Promise<{ connected: boolean; lastSyncAt: number | null }>;
  getAccountProfile(accountId: string, tenantId: string): Promise<{ plan: string; seats: number }>;
  getServiceStatus(tenantId: string): Promise<{ healthy: boolean; incidents: string[] }>;
  refund(orderId: string, amountCents: number, tenantId: string, idempotencyKey: string): Promise<{ refundId: string }>;
  changePlan(accountId: string, plan: string, tenantId: string, idempotencyKey: string): Promise<{ effectiveAt: number }>;
  resetCredential(integrationId: string, tenantId: string, idempotencyKey: string): Promise<{ rotatedAt: number }>;
}

/** 内存 fake backend：单测注入用，所有副作用可计数 */
export class FakeBackend implements Backend {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  refunds: Array<{ orderId: string; amountCents: number; tenantId: string }> = [];
  tickets: Array<Record<string, unknown>> = [];
  private clock: () => number;
  private readonly writeResults = new Map<string, any>();

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async getOrderStatus(orderId: string, tenantId: string) {
    this.record("getOrderStatus", [orderId, tenantId]);
    return { status: "shipped", updatedAt: this.clock() };
  }
  async getBillingSummary(accountId: string, tenantId: string) {
    this.record("getBillingSummary", [accountId, tenantId]);
    return { amountCents: 19900, period: "2026-08" };
  }
  async getIntegrationStatus(accountId: string, tenantId: string) {
    this.record("getIntegrationStatus", [accountId, tenantId]);
    return { connected: true, lastSyncAt: this.clock() };
  }
  async getAccountProfile(accountId: string, tenantId: string) {
    this.record("getAccountProfile", [accountId, tenantId]);
    return { plan: "pro", seats: 20 };
  }
  async getServiceStatus(tenantId: string) {
    this.record("getServiceStatus", [tenantId]);
    return { healthy: true, incidents: [] };
  }
  async refund(orderId: string, amountCents: number, tenantId: string, idempotencyKey: string) {
    const key = JSON.stringify([tenantId, "refund", idempotencyKey]);
    if (this.writeResults.has(key)) return this.writeResults.get(key) as { refundId: string };
    this.record("refund", [orderId, amountCents, tenantId]);
    this.refunds.push({ orderId, amountCents, tenantId });
    const result = { refundId: `rf-${orderId}-${this.refunds.length}` };
    this.writeResults.set(key, result);
    return result;
  }
  async changePlan(accountId: string, plan: string, tenantId: string, idempotencyKey: string) {
    const key = JSON.stringify([tenantId, "plan", idempotencyKey]);
    if (this.writeResults.has(key)) return this.writeResults.get(key) as { effectiveAt: number };
    this.record("changePlan", [accountId, plan, tenantId]);
    const result = { effectiveAt: this.clock() };
    this.writeResults.set(key, result);
    return result;
  }
  async resetCredential(integrationId: string, tenantId: string, idempotencyKey: string) {
    const key = JSON.stringify([tenantId, "credential", idempotencyKey]);
    if (this.writeResults.has(key)) return this.writeResults.get(key) as { rotatedAt: number };
    this.record("resetCredential", [integrationId, tenantId]);
    const result = { rotatedAt: this.clock() };
    this.writeResults.set(key, result);
    return result;
  }
}

const TenantAccount = z.object({
  accountId: z.string().min(1),
});

const Credentials = {
  read: { read: "READ_DB_DSN" },
  write: { read: "READ_DB_DSN", write: "WRITE_SERVICE_TOKEN" },
};

// ---------------------------------------------------------------------------
// read 类工具
// ---------------------------------------------------------------------------

export function createOrderStatusTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "get_order_status",
    description: "查询订单当前状态与最后更新时间（实时数据，不得凭记忆作答）",
    kind: "read",
    domains: ["order"],
    idempotent: true,
    credential: Credentials.read,
    schema: z.object({ orderId: z.string().min(1) }),
    async execute(input, ctx) {
      return backend.getOrderStatus(input.orderId, ctx.tenantId);
    },
  };
}

export function createBillingSummaryTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "get_billing_summary",
    description: "查询账户当期账单金额与账期",
    kind: "read",
    domains: ["billing"],
    idempotent: true,
    credential: Credentials.read,
    schema: TenantAccount,
    async execute(input, ctx) {
      return backend.getBillingSummary(input.accountId, ctx.tenantId);
    },
  };
}

export function createIntegrationStatusTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "get_integration_status",
    description: "查询集成配置的连通状态与最近同步时间",
    kind: "read",
    domains: ["integration"],
    idempotent: true,
    credential: Credentials.read,
    schema: TenantAccount,
    async execute(input, ctx) {
      return backend.getIntegrationStatus(input.accountId, ctx.tenantId);
    },
  };
}

export function createAccountProfileTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "get_account_profile",
    description: "查询账户套餐与席位数",
    kind: "read",
    domains: ["account"],
    idempotent: true,
    credential: Credentials.read,
    schema: TenantAccount,
    async execute(input, ctx) {
      return backend.getAccountProfile(input.accountId, ctx.tenantId);
    },
  };
}

export function createServiceStatusTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "get_service_status",
    description: "查询当前服务健康状态与进行中的故障",
    kind: "read",
    domains: ["technical"],
    idempotent: true,
    credential: Credentials.read,
    schema: z.object({}),
    async execute(_input, ctx) {
      return backend.getServiceStatus(ctx.tenantId);
    },
  };
}

// ---------------------------------------------------------------------------
// write 类工具：全部 requiresConfirmation + idempotent（由 assertToolContract 强制）
// ---------------------------------------------------------------------------

export function createRefundTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "propose_refund",
    description: "提议退款。需用户确认后由确定性后端执行",
    kind: "write",
    domains: ["order", "billing"],
    requiresConfirmation: true,
    idempotent: true,
    credential: Credentials.write,
    schema: z.object({
      orderId: z.string().min(1),
      amountCents: z.number().int().positive(),
    }),
    async execute(input, ctx) {
      return backend.refund(input.orderId, input.amountCents, ctx.tenantId, ctx.operationKey!);
    },
  };
}

export function createPlanChangeTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "propose_plan_change",
    description: "提议套餐变更。需用户确认后由确定性后端执行",
    kind: "write",
    domains: ["billing"],
    requiresConfirmation: true,
    idempotent: true,
    credential: Credentials.write,
    schema: z.object({
      accountId: z.string().min(1),
      plan: z.string().min(1),
    }),
    async execute(input, ctx) {
      return backend.changePlan(input.accountId, input.plan, ctx.tenantId, ctx.operationKey!);
    },
  };
}

export function createCredentialResetTool(backend: Backend): AgentTool<any, any> {
  return {
    name: "propose_credential_reset",
    description: "提议重置集成凭证。需用户确认后由确定性后端执行",
    kind: "write",
    domains: ["integration"],
    requiresConfirmation: true,
    idempotent: true,
    credential: Credentials.write,
    schema: z.object({
      integrationId: z.string().min(1),
    }),
    async execute(input, ctx) {
      return backend.resetCredential(input.integrationId, ctx.tenantId, ctx.operationKey!);
    },
  };
}

/**
 * 建单工具（T5.4）。
 * write 类 + 幂等：重复触发不产生两张单——由 T3.2 幂等键保证，
 * 而不是靠「调用方记得先查一遍」。
 */
export function createTicketTool(
  create: (input: {
    tenantId: string;
    threadId: string;
    category?: string;
    subject?: string;
    handoff?: Record<string, unknown>;
    humanInvolved?: boolean;
    idempotencyKey?: string;
  }) => Promise<{ id: string }>,
): AgentTool<any, any> {
  return {
    name: "create_ticket",
    description: "创建人工客服工单。需用户确认后由确定性后端执行",
    kind: "write",
    domains: ["billing", "integration", "account", "technical", "order", "general"],
    requiresConfirmation: true,
    idempotent: true,
    credential: Credentials.write,
    schema: z.object({
      category: z.string().default("general"),
      subject: z.string().default(""),
      handoff: z.record(z.string(), z.unknown()).nullable().default(null),
    }),
    async execute(input, ctx) {
      const ticket = await create({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        category: input.category,
        subject: input.subject,
        handoff: input.handoff ?? undefined,
        humanInvolved: true,
        // 幂等键把「同会话同主题」收敛成一张单
        idempotencyKey: ctx.operationKey,
      });
      return { ticketId: ticket.id };
    },
  };
}

/** 默认工具集 */
export function defaultTools(
  backend: Backend,
  createTicket: Parameters<typeof createTicketTool>[0],
): AgentTool<any, any>[] {
  return [
    createOrderStatusTool(backend),
    createBillingSummaryTool(backend),
    createIntegrationStatusTool(backend),
    createAccountProfileTool(backend),
    createServiceStatusTool(backend),
    createRefundTool(backend),
    createPlanChangeTool(backend),
    createCredentialResetTool(backend),
    createTicketTool(createTicket),
  ];
}
