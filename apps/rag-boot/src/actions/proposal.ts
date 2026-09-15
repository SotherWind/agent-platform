import { z } from "zod/v4";
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { stableStringify, type AgentTool, type ConfirmationCheck } from "../tools/contract";
import { GuardrailBlockedError } from "../errors";
import { LeaseLostError, OperationInProgressError } from "../reliability/lease-store";
import { MemoryProposalStore, type ProposalStore } from "./proposal-store";

export const ActionProposalSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  summary: z.string(),
  tenantId: z.string().min(1),
  threadId: z.string().min(1),
  principal: z.string().min(1),
  confirmToken: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(["pending", "confirmed", "queued", "executing", "failed", "executed", "expired", "rejected"]),
  idempotencyKey: z.string(),
  executionOwner: z.string().nullable().optional(),
  executionLeaseUntil: z.number().nullable().optional(),
  executionResult: z.unknown().nullable().optional(),
  signalId: z.string().nullable().optional(),
  queuedAt: z.number().optional(),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ActionResultSchema = z.object({
  proposalId: z.string(),
  action: z.string(),
  ok: z.boolean(),
  result: z.unknown().nullable().default(null),
  error: z.string().nullable().default(null),
  at: z.number(),
  deterministic: z.boolean().default(true),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export interface ProposalServiceOptions {
  secret?: string;
  store?: ProposalStore;
  ttlMs?: number;
  leaseMs?: number;
  clock?: () => number;
  onAudit?: (entry: {
    kind: "propose" | "confirm" | "reject" | "execute" | "expire";
    proposal: ActionProposal;
    at: number;
    detail?: string;
  }) => void;
}

function deny(reasonCode: string, message: string): never {
  throw new GuardrailBlockedError(message, { stage: "actions", reasonCode });
}

function equalToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function businessParams(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) =>
    !["tenantId", "threadId", "principal", "confirmToken", "authContext"].includes(key)));
}

/** Authoritative action lifecycle. Returned objects are snapshots, never mutable authority. */
export class ProposalService {
  readonly durable: boolean;
  readonly productionReady: boolean;
  private readonly secret: string;
  private readonly store: ProposalStore;
  private readonly ttlMs: number;
  private readonly leaseMs: number;
  private readonly clock: () => number;
  private readonly onAudit: NonNullable<ProposalServiceOptions["onAudit"]>;

  constructor(options: ProposalServiceOptions = {}) {
    this.secret = options.secret ?? randomBytes(32).toString("hex");
    this.store = options.store ?? new MemoryProposalStore();
    this.durable = this.store.durable;
    this.productionReady = this.durable && Buffer.byteLength(options.secret ?? "") >= 32 &&
      options.secret !== "rag-boot-dev-secret";
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    if (this.ttlMs <= 0 || this.leaseMs <= 0) throw new Error("Action TTL and lease must be positive.");
    this.clock = options.clock ?? Date.now;
    this.onAudit = options.onAudit ?? (() => {});
  }

  private token(proposal: Pick<ActionProposal,
    "id" | "action" | "params" | "tenantId" | "threadId" | "principal" | "expiresAt">): string {
    return createHmac("sha256", this.secret).update(stableStringify({
      id: proposal.id, action: proposal.action, params: proposal.params,
      tenantId: proposal.tenantId, threadId: proposal.threadId,
      principal: proposal.principal, expiresAt: proposal.expiresAt,
    })).digest("hex");
  }

  private require(id: string): ActionProposal {
    return this.store.get(id) ?? deny("proposal_not_found", "Proposal not found.");
  }

  private audit(kind: Parameters<NonNullable<ProposalServiceOptions["onAudit"]>>[0]["kind"],
    proposal: ActionProposal, detail?: string): void {
    this.onAudit({ kind, proposal: structuredClone(proposal), at: this.clock(), detail });
  }

  propose(input: {
    action: string; params: Record<string, unknown>; summary: string;
    tenantId: string; threadId: string; principal: string;
  }): ActionProposal {
    const now = this.clock();
    const proposal = ActionProposalSchema.parse({
      ...input, params: structuredClone(businessParams(input.params)),
      id: `prop-${randomUUID()}`, confirmToken: "", idempotencyKey: "",
      createdAt: now, expiresAt: now + this.ttlMs, status: "pending",
    });
    proposal.confirmToken = this.token(proposal);
    // A newly requested action is distinct; retries of the same proposal reuse this key forever.
    proposal.idempotencyKey = createHash("sha256")
      .update(stableStringify([proposal.tenantId, proposal.principal, proposal.id])).digest("hex");
    this.store.insert(proposal);
    this.audit("propose", proposal);
    return structuredClone(proposal);
  }

  get(id: string): ActionProposal | undefined { return this.store.get(id); }
  all(): ActionProposal[] { return this.store.all(); }

  confirm(input: {
    proposalId: string; token: string; tenantId: string; threadId: string; principal: string;
  }): ActionProposal {
    const current = this.require(input.proposalId);
    if (input.tenantId !== current.tenantId || input.threadId !== current.threadId ||
        input.principal !== current.principal || !equalToken(this.token(current), input.token)) {
      this.audit("reject", current, "confirmation identity mismatch");
      deny("token_identity_mismatch", "Confirm token is not valid for this session.");
    }
    const proposal = this.store.change(current.id, (p) => {
      if (["expired", "rejected"].includes(p.status)) return p;
      // Repeating confirm never regresses queued/executing/executed state.
      if (p.status !== "pending") return p;
      return { ...p, status: this.clock() >= p.expiresAt ? "expired" : "confirmed" };
    });
    if (proposal.status === "expired") {
      this.audit("expire", proposal);
      deny("proposal_expired", "Proposal expired. Please request a new one.");
    }
    if (proposal.status === "rejected") deny("not_confirmed", "Proposal was rejected.");
    if (current.status === "pending") this.audit("confirm", proposal);
    return proposal;
  }

  verifyConfirmation(input: ConfirmationCheck): { idempotencyKey: string } | null {
    const p = this.get(input.proposalId);
    if (!p || !["confirmed", "queued", "executing", "failed"].includes(p.status)) return null;
    if (p.queuedAt === undefined && this.clock() >= p.expiresAt) return null;
    if (!equalToken(this.token(p), input.token) || p.action !== input.toolName ||
        p.tenantId !== input.tenantId || p.threadId !== input.threadId ||
        p.principal !== input.principal || stableStringify(p.params) !== stableStringify(input.args)) return null;
    return { idempotencyKey: p.idempotencyKey };
  }

  /** Reserve the stable signal identity before emit, so a crash can safely repeat submission. */
  markQueued(proposalId: string, signalId: string): ActionProposal {
    this.require(proposalId);
    return this.store.change(proposalId, (p) => {
      if (p.signalId) {
        if (p.signalId !== signalId) deny("signal_mismatch", "Proposal is already linked to another signal.");
        return p;
      }
      if (p.status !== "confirmed") deny("not_confirmed", "Only a confirmed proposal can be queued.");
      if (this.clock() >= p.expiresAt) deny("proposal_expired", "Confirmed proposal expired before submission.");
      return { ...p, status: "queued", signalId, queuedAt: this.clock() };
    });
  }

  async execute(
    snapshot: ActionProposal,
    tool: AgentTool<any, any>,
    executeFn: (tool: AgentTool<any, any>, input: unknown, token: string) => Promise<unknown>,
  ): Promise<ActionResult> {
    const stored = this.require(snapshot.id);
    if (snapshot.action !== stored.action || stableStringify(snapshot.params) !== stableStringify(stored.params) ||
        snapshot.tenantId !== stored.tenantId || snapshot.threadId !== stored.threadId ||
        snapshot.principal !== stored.principal || snapshot.confirmToken !== stored.confirmToken) {
      deny("proposal_tampered", "Proposal contents do not match the stored proposal.");
    }
    if (tool.kind !== "write" || !tool.requiresConfirmation) deny("invalid_write_tool", "A confirmed write tool is required.");
    if (tool.name !== stored.action) deny("proposal_tool_mismatch", "Proposal action does not match the tool.");
    const owner = randomUUID();
    const claimed = this.store.change(stored.id, (p) => {
      if (p.status === "executed") return p;
      if (!["confirmed", "queued", "failed", "executing"].includes(p.status)) {
        deny("not_confirmed", "Proposal is not confirmed. Execution refused.");
      }
      if (p.queuedAt === undefined && this.clock() >= p.expiresAt) {
        deny("proposal_expired", "Confirmed proposal expired before execution.");
      }
      if (p.status === "executing" && (p.executionLeaseUntil ?? 0) > this.clock()) {
        throw new OperationInProgressError(p.id);
      }
      return { ...p, status: "executing", executionOwner: owner, executionLeaseUntil: this.clock() + this.leaseMs };
    });
    const resultOf = (ok: boolean, result: unknown, error: string | null): ActionResult =>
      ActionResultSchema.parse({
        proposalId: stored.id, action: stored.action, ok, result, error, at: this.clock(), deterministic: true,
      });
    if (claimed.status === "executed") return resultOf(true, claimed.executionResult, null);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        this.store.change(stored.id, (p) => {
          if (p.executionOwner !== owner || p.status !== "executing" || (p.executionLeaseUntil ?? 0) <= this.clock()) {
            throw new LeaseLostError();
          }
          return { ...p, executionLeaseUntil: this.clock() + this.leaseMs };
        });
      } catch { leaseLost = true; }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      const result = await executeFn(tool, structuredClone(claimed.params), claimed.confirmToken);
      const executed = this.store.change(stored.id, (p) => {
        if (leaseLost || p.executionOwner !== owner || (p.executionLeaseUntil ?? 0) <= this.clock()) throw new LeaseLostError();
        return { ...p, status: "executed", executionOwner: null, executionLeaseUntil: null, executionResult: result };
      });
      this.audit("execute", executed);
      return resultOf(true, result, null);
    } catch (error) {
      this.store.change(stored.id, (p) =>
        p.status === "executing" && p.executionOwner === owner && (p.executionLeaseUntil ?? 0) > this.clock()
          ? { ...p, status: "failed", executionOwner: null, executionLeaseUntil: null } : p);
      this.audit("execute", stored, error instanceof Error ? error.message : String(error));
      if (error instanceof LeaseLostError) throw error;
      return resultOf(false, null, error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(heartbeat);
    }
  }
}
