import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  stableStringify,
  type Backend,
} from "@agent-platform/rag-boot";

export interface LocalCrmAdapterOptions {
  /** 与 server 其他持久化模块共享的 SQLite 文件；默认仅用于测试的内存库。 */
  path?: string;
  clock?: () => number;
}

export interface CrmRefundRecord {
  refundId: string;
  tenantId: string;
  orderId: string;
  amountCents: number;
  status: "succeeded";
  createdAt: number;
  operationKey: string;
}

export class CrmDataError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "CrmDataError";
    this.reasonCode = reasonCode;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crm_accounts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  seats INTEGER NOT NULL,
  billing_amount_cents INTEGER NOT NULL,
  billing_period TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE IF NOT EXISTS crm_orders (
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  refundable_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_orders_account
  ON crm_orders (tenant_id, account_id);

CREATE TABLE IF NOT EXISTS crm_integrations (
  tenant_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connected INTEGER NOT NULL,
  last_sync_at INTEGER,
  PRIMARY KEY (tenant_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_integrations_account
  ON crm_integrations (tenant_id, account_id);

CREATE TABLE IF NOT EXISTS crm_credentials (
  tenant_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rotated_at INTEGER,
  PRIMARY KEY (tenant_id, integration_id)
);

CREATE TABLE IF NOT EXISTS crm_refunds (
  refund_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  operation_key TEXT NOT NULL,
  UNIQUE (tenant_id, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_refunds_order
  ON crm_refunds (tenant_id, order_id);

CREATE TABLE IF NOT EXISTS crm_plan_changes (
  change_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  from_plan TEXT NOT NULL,
  to_plan TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  operation_key TEXT NOT NULL,
  UNIQUE (tenant_id, operation_key)
);

CREATE TABLE IF NOT EXISTS crm_credential_rotations (
  rotation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  operation_key TEXT NOT NULL,
  UNIQUE (tenant_id, operation_key)
);

CREATE TABLE IF NOT EXISTS crm_incidents (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (tenant_id, incident_id)
);

/*
 * 业务系统自己的幂等账本。
 *
 * 上层 tools/idempotency 保护 Agent 重试；这里保护“CRM 已提交但 signal
 * 回执丢失后再次投递”的窗口。两层都保留，才能把 outbox 重放变成安全操作。
 */
CREATE TABLE IF NOT EXISTS crm_operations (
  tenant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  action TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, operation_key)
);
`;

const SEED_ACCOUNTS = [
  {
    tenantId: "tenant-demo",
    accountId: "acct-demo",
    plan: "pro",
    seats: 24,
    billingAmountCents: 19_900,
    billingPeriod: "2026-09",
  },
  {
    tenantId: "tenant-other",
    accountId: "acct-other",
    plan: "enterprise",
    seats: 120,
    billingAmountCents: 199_900,
    billingPeriod: "2026-09",
  },
] as const;

const SEED_ORDERS = [
  {
    tenantId: "tenant-demo",
    orderId: "order-demo-private",
    accountId: "acct-demo",
    status: "shipped",
    totalAmountCents: 29_900,
    refundableAmountCents: 29_900,
    currency: "CNY",
  },
  {
    tenantId: "tenant-demo",
    orderId: "order-demo-refund",
    accountId: "acct-demo",
    status: "shipped",
    totalAmountCents: 29_900,
    refundableAmountCents: 29_900,
    currency: "CNY",
  },
  {
    tenantId: "tenant-demo",
    orderId: "order-demo-refunded",
    accountId: "acct-demo",
    status: "refunded",
    totalAmountCents: 15_900,
    refundableAmountCents: 0,
    currency: "CNY",
  },
  {
    tenantId: "tenant-demo",
    orderId: "order-demo-cancelled",
    accountId: "acct-demo",
    status: "cancelled",
    totalAmountCents: 9_900,
    refundableAmountCents: 0,
    currency: "CNY",
  },
  {
    tenantId: "tenant-other",
    orderId: "order-demo-refund",
    accountId: "acct-other",
    status: "delivered",
    totalAmountCents: 29_900,
    refundableAmountCents: 29_900,
    currency: "CNY",
  },
] as const;

const SEED_INTEGRATIONS = [
  {
    tenantId: "tenant-demo",
    integrationId: "integration-demo",
    accountId: "acct-demo",
    connected: true,
  },
  {
    tenantId: "tenant-other",
    integrationId: "integration-other",
    accountId: "acct-other",
    connected: false,
  },
] as const;

interface OrderRow {
  tenant_id: string;
  order_id: string;
  account_id: string;
  status: string;
  updated_at: number;
  total_amount_cents: number;
  refundable_amount_cents: number;
  currency: string;
}

interface AccountRow {
  tenant_id: string;
  account_id: string;
  plan: string;
  seats: number;
  billing_amount_cents: number;
  billing_period: string;
}

interface IntegrationRow {
  tenant_id: string;
  integration_id: string;
  account_id: string;
  connected: number;
  last_sync_at: number | null;
}

interface OperationRow {
  action: string;
  request_json: string;
  result_json: string;
}

interface CredentialRow {
  version: number;
  rotated_at: number | null;
}

export class LocalCrmAdapter implements Backend {
  readonly durable: boolean;
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(options: LocalCrmAdapterOptions = {}) {
    const path = options.path ?? ":memory:";
    this.durable = path !== ":memory:" && path !== "";
    this.clock = options.clock ?? Date.now;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.seed();
  }

  close(): void {
    this.db.close();
  }

  async getOrderStatus(orderId: string, tenantId: string) {
    const row = this.db.prepare(`
      SELECT tenant_id, order_id, account_id, status, updated_at,
             total_amount_cents, refundable_amount_cents, currency
      FROM crm_orders
      WHERE tenant_id = ? AND order_id = ?
    `).get(tenantId, orderId) as OrderRow | undefined;
    if (!row) throw new CrmDataError("order_not_found", "订单不存在");
    return {
      orderId: row.order_id,
      accountId: row.account_id,
      status: row.status,
      updatedAt: row.updated_at,
      totalAmountCents: row.total_amount_cents,
      refundableAmountCents: row.refundable_amount_cents,
      currency: row.currency,
    };
  }

  async getBillingSummary(accountId: string, tenantId: string) {
    const row = this.account(tenantId, accountId);
    return {
      accountId: row.account_id,
      amountCents: row.billing_amount_cents,
      period: row.billing_period,
      plan: row.plan,
      currency: "CNY",
    };
  }

  async getIntegrationStatus(accountId: string, tenantId: string) {
    const row = this.db.prepare(`
      SELECT tenant_id, integration_id, account_id, connected, last_sync_at
      FROM crm_integrations
      WHERE tenant_id = ? AND account_id = ?
    `).get(tenantId, accountId) as IntegrationRow | undefined;
    if (!row) throw new CrmDataError("integration_not_found", "集成不存在");
    const credential = this.db.prepare(`
      SELECT version, rotated_at
      FROM crm_credentials
      WHERE tenant_id = ? AND integration_id = ?
    `).get(tenantId, row.integration_id) as CredentialRow | undefined;
    return {
      integrationId: row.integration_id,
      connected: Boolean(row.connected),
      lastSyncAt: row.last_sync_at,
      credentialVersion: credential?.version ?? 1,
      credentialRotatedAt: credential?.rotated_at ?? null,
    };
  }

  async getAccountProfile(accountId: string, tenantId: string) {
    const row = this.account(tenantId, accountId);
    return {
      accountId: row.account_id,
      plan: row.plan,
      seats: row.seats,
    };
  }

  async getServiceStatus(tenantId: string) {
    const rows = this.db.prepare(`
      SELECT message
      FROM crm_incidents
      WHERE tenant_id = ? AND status = 'open'
      ORDER BY incident_id
    `).all(tenantId) as Array<{ message: string }>;
    return {
      healthy: rows.length === 0,
      incidents: rows.map((row) => row.message),
    };
  }

  async refund(orderId: string, amountCents: number, tenantId: string, idempotencyKey: string) {
    this.requireAmount(amountCents);
    this.requireOperationKey(idempotencyKey);
    return this.db.transaction(() => {
      const request = { orderId, amountCents };
      const previous = this.readOperation<{ refundId: string }>(tenantId, "refund", request, idempotencyKey);
      if (previous) return previous;

      const order = this.order(tenantId, orderId);
      if (!["paid", "shipped", "delivered", "partially_refunded"].includes(order.status)) {
        throw new CrmDataError("order_not_refundable", "订单当前状态不可退款");
      }
      if (order.refundable_amount_cents < amountCents) {
        throw new CrmDataError("refund_amount_exceeded", "可退款金额不足");
      }

      const now = this.clock();
      const refundId = `rf-${randomUUID()}`;
      const remaining = order.refundable_amount_cents - amountCents;
      const nextStatus = remaining === 0 ? "refunded" : "partially_refunded";
      this.db.prepare(`
        INSERT INTO crm_refunds
          (refund_id, tenant_id, order_id, amount_cents, status, created_at, operation_key)
        VALUES (?, ?, ?, ?, 'succeeded', ?, ?)
      `).run(refundId, tenantId, orderId, amountCents, now, idempotencyKey);
      this.db.prepare(`
        UPDATE crm_orders
        SET status = ?, refundable_amount_cents = ?, updated_at = ?
        WHERE tenant_id = ? AND order_id = ?
      `).run(nextStatus, remaining, now, tenantId, orderId);

      const result = {
        refundId,
        orderId,
        amountCents,
        status: "succeeded" as const,
        remainingRefundableAmountCents: remaining,
      };
      this.recordOperation(tenantId, "refund", request, idempotencyKey, result, now);
      return result;
    }).immediate();
  }

  async changePlan(accountId: string, plan: string, tenantId: string, idempotencyKey: string) {
    this.requireOperationKey(idempotencyKey);
    if (!["starter", "pro", "enterprise"].includes(plan)) {
      throw new CrmDataError("invalid_plan", "不支持的套餐");
    }
    return this.db.transaction(() => {
      const request = { accountId, plan };
      const previous = this.readOperation<{ effectiveAt: number }>(
        tenantId, "change_plan", request, idempotencyKey,
      );
      if (previous) return previous;

      const account = this.account(tenantId, accountId);
      const now = this.clock();
      this.db.prepare(`
        INSERT INTO crm_plan_changes
          (change_id, tenant_id, account_id, from_plan, to_plan, effective_at, operation_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `pc-${randomUUID()}`, tenantId, accountId, account.plan, plan, now, idempotencyKey,
      );
      this.db.prepare(`
        UPDATE crm_accounts SET plan = ?
        WHERE tenant_id = ? AND account_id = ?
      `).run(plan, tenantId, accountId);

      const result = {
        effectiveAt: now,
        accountId,
        previousPlan: account.plan,
        plan,
      };
      this.recordOperation(tenantId, "change_plan", request, idempotencyKey, result, now);
      return result;
    }).immediate();
  }

  async resetCredential(integrationId: string, tenantId: string, idempotencyKey: string) {
    this.requireOperationKey(idempotencyKey);
    return this.db.transaction(() => {
      const request = { integrationId };
      const previous = this.readOperation<{ rotatedAt: number }>(
        tenantId, "reset_credential", request, idempotencyKey,
      );
      if (previous) return previous;

      const integration = this.db.prepare(`
        SELECT tenant_id, integration_id, account_id, connected, last_sync_at
        FROM crm_integrations
        WHERE tenant_id = ? AND integration_id = ?
      `).get(tenantId, integrationId) as IntegrationRow | undefined;
      if (!integration) throw new CrmDataError("integration_not_found", "集成不存在");

      const current = this.db.prepare(`
        SELECT version, rotated_at
        FROM crm_credentials
        WHERE tenant_id = ? AND integration_id = ?
      `).get(tenantId, integrationId) as CredentialRow | undefined;
      const version = (current?.version ?? 0) + 1;
      const now = this.clock();
      this.db.prepare(`
        INSERT INTO crm_credentials (tenant_id, integration_id, version, rotated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant_id, integration_id)
        DO UPDATE SET version = excluded.version, rotated_at = excluded.rotated_at
      `).run(tenantId, integrationId, version, now);
      this.db.prepare(`
        INSERT INTO crm_credential_rotations
          (rotation_id, tenant_id, integration_id, version, rotated_at, operation_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`cr-${randomUUID()}`, tenantId, integrationId, version, now, idempotencyKey);

      const result = {
        rotatedAt: now,
        integrationId,
        credentialVersion: version,
      };
      this.recordOperation(tenantId, "reset_credential", request, idempotencyKey, result, now);
      return result;
    }).immediate();
  }

  async listRefunds(tenantId: string, orderId?: string): Promise<CrmRefundRecord[]> {
    const rows = this.db.prepare(`
      SELECT refund_id, tenant_id, order_id, amount_cents, status, created_at, operation_key
      FROM crm_refunds
      WHERE tenant_id = ? AND (? IS NULL OR order_id = ?)
      ORDER BY created_at, refund_id
    `).all(tenantId, orderId ?? null, orderId ?? null) as Array<{
      refund_id: string;
      tenant_id: string;
      order_id: string;
      amount_cents: number;
      status: "succeeded";
      created_at: number;
      operation_key: string;
    }>;
    return rows.map((row) => ({
      refundId: row.refund_id,
      tenantId: row.tenant_id,
      orderId: row.order_id,
      amountCents: row.amount_cents,
      status: row.status,
      createdAt: row.created_at,
      operationKey: row.operation_key,
    }));
  }

  private account(tenantId: string, accountId: string): AccountRow {
    const row = this.db.prepare(`
      SELECT tenant_id, account_id, plan, seats, billing_amount_cents, billing_period
      FROM crm_accounts
      WHERE tenant_id = ? AND account_id = ?
    `).get(tenantId, accountId) as AccountRow | undefined;
    if (!row) throw new CrmDataError("account_not_found", "账户不存在");
    return row;
  }

  private order(tenantId: string, orderId: string): OrderRow {
    const row = this.db.prepare(`
      SELECT tenant_id, order_id, account_id, status, updated_at,
             total_amount_cents, refundable_amount_cents, currency
      FROM crm_orders
      WHERE tenant_id = ? AND order_id = ?
    `).get(tenantId, orderId) as OrderRow | undefined;
    if (!row) throw new CrmDataError("order_not_found", "订单不存在");
    return row;
  }

  private readOperation<T>(
    tenantId: string,
    action: string,
    request: Record<string, unknown>,
    operationKey: string,
  ): T | undefined {
    const row = this.db.prepare(`
      SELECT action, request_json, result_json
      FROM crm_operations
      WHERE tenant_id = ? AND operation_key = ?
    `).get(tenantId, operationKey) as OperationRow | undefined;
    if (!row) return undefined;
    if (row.action !== action || row.request_json !== stableStringify(request)) {
      throw new CrmDataError("operation_key_conflict", "幂等键已用于其他业务请求");
    }
    return JSON.parse(row.result_json) as T;
  }

  private recordOperation(
    tenantId: string,
    action: string,
    request: Record<string, unknown>,
    operationKey: string,
    result: unknown,
    createdAt: number,
  ): void {
    this.db.prepare(`
      INSERT INTO crm_operations
        (tenant_id, operation_key, action, request_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      operationKey,
      action,
      stableStringify(request),
      JSON.stringify(result),
      createdAt,
    );
  }

  private requireAmount(amountCents: number): void {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new CrmDataError("invalid_amount", "金额必须是正整数分");
    }
  }

  private requireOperationKey(operationKey: string): void {
    if (!operationKey.trim()) throw new CrmDataError("missing_operation_key", "缺少业务幂等键");
  }

  private seed(): void {
    const now = this.clock();
    this.db.transaction(() => {
      const account = this.db.prepare(`
        INSERT OR IGNORE INTO crm_accounts
          (tenant_id, account_id, plan, seats, billing_amount_cents, billing_period)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of SEED_ACCOUNTS) {
        account.run(
          item.tenantId, item.accountId, item.plan, item.seats,
          item.billingAmountCents, item.billingPeriod,
        );
      }

      const order = this.db.prepare(`
        INSERT OR IGNORE INTO crm_orders
          (tenant_id, order_id, account_id, status, updated_at,
           total_amount_cents, refundable_amount_cents, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of SEED_ORDERS) {
        order.run(
          item.tenantId, item.orderId, item.accountId, item.status, now,
          item.totalAmountCents, item.refundableAmountCents, item.currency,
        );
      }

      const integration = this.db.prepare(`
        INSERT OR IGNORE INTO crm_integrations
          (tenant_id, integration_id, account_id, connected, last_sync_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const credentials = this.db.prepare(`
        INSERT OR IGNORE INTO crm_credentials
          (tenant_id, integration_id, version, rotated_at)
        VALUES (?, ?, 1, NULL)
      `);
      for (const item of SEED_INTEGRATIONS) {
        integration.run(
          item.tenantId, item.integrationId, item.accountId,
          item.connected ? 1 : 0, item.connected ? now : null,
        );
        credentials.run(item.tenantId, item.integrationId);
      }

      this.db.prepare(`
        INSERT OR IGNORE INTO crm_incidents
          (tenant_id, incident_id, message, status)
        VALUES ('tenant-other', 'inc-demo-1', '支付网关存在延迟', 'open')
      `).run();

      const refundedSeed = this.db.prepare(`
        INSERT OR IGNORE INTO crm_refunds
          (refund_id, tenant_id, order_id, amount_cents, status, created_at, operation_key)
        VALUES ('rf-seed-refunded', 'tenant-demo', 'order-demo-refunded',
                15900, 'succeeded', ?, 'seed:refund:order-demo-refunded')
      `).run(now);
      if (refundedSeed.changes > 0) {
        this.db.prepare(`
          INSERT OR IGNORE INTO crm_operations
            (tenant_id, operation_key, action, request_json, result_json, created_at)
          VALUES ('tenant-demo', 'seed:refund:order-demo-refunded', 'refund',
                  '{"amountCents":15900,"orderId":"order-demo-refunded"}',
                  '{"amountCents":15900,"orderId":"order-demo-refunded","refundId":"rf-seed-refunded","status":"succeeded","remainingRefundableAmountCents":0}',
                  ?)
        `).run(now);
      }
    }).immediate();
  }
}
