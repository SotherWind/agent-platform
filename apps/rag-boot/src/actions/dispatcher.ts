import { ActionGuardrails } from "../guardrails/action";
import { GuardrailBlockedError } from "../errors";
import { executeTool, stableStringify, type AgentTool, type AuditEntry } from "../tools/contract";
import type { IdempotencyStore } from "../tools/idempotency";
import type { ProposalService, ActionProposal } from "./proposal";
import type { ActionSignal, ActionSignalBus } from "./signal";

export interface ActionDispatcherOptions {
  proposals: ProposalService;
  signals: ActionSignalBus;
  tools: AgentTool[];
  idempotency: IdempotencyStore;
  guardrails: ActionGuardrails;
  audit?: (entry: AuditEntry) => void;
  clock?: () => number;
}

/** Confirmation and delivery use stored parameters exclusively; neither path calls a model. */
export class ActionDispatcher {
  constructor(private readonly options: ActionDispatcherOptions) {}

  private toolFor(proposal: ActionProposal): AgentTool {
    const tool = this.options.tools.find((candidate) => candidate.name === proposal.action);
    if (!tool || tool.kind !== "write") throw new Error("Confirmed action has no registered write tool.");
    const verdict = this.options.guardrails.check({
      toolName: tool.name,
      kind: tool.kind,
      allowlist: this.options.tools.map((candidate) => candidate.name),
      principal: proposal.principal,
      confirmed: true,
      amountCents: typeof proposal.params.amountCents === "number" ? proposal.params.amountCents : undefined,
    });
    if (!verdict.allowed) {
      throw new GuardrailBlockedError("Confirmed action violates the current policy.", {
        stage: "actions", reasonCode: verdict.code,
      });
    }
    return tool;
  }

  private emit(proposal: ActionProposal): Promise<ActionSignal> {
    return this.options.signals.emit({
      type: proposal.action,
      tenantId: proposal.tenantId,
      principal: proposal.principal,
      threadId: proposal.threadId,
      proposalId: proposal.id,
      payload: proposal.params,
      idempotencyKey: proposal.idempotencyKey,
    });
  }

  async submit(input: Parameters<ProposalService["confirm"]>[0]) {
    const confirmed = this.options.proposals.confirm(input);
    if (confirmed.status !== "executed") this.toolFor(confirmed);
    const proposal = this.options.proposals.markQueued(confirmed.id, `sig-${confirmed.idempotencyKey}`);
    const signal = await this.emit(proposal);
    return { proposal, signal };
  }

  /** Rebuild missing outbox rows after a crash between reservation and insertion. */
  async flush() {
    for (const proposal of this.options.proposals.all()) {
      if (proposal.signalId) await this.emit(proposal);
    }
    return this.options.signals.dispatchPending(async (signal) => {
      const proposal = signal.proposalId ? this.options.proposals.get(signal.proposalId) : undefined;
      if (!proposal || proposal.signalId !== signal.id ||
          proposal.tenantId !== signal.tenantId || proposal.threadId !== signal.threadId ||
          proposal.principal !== signal.principal || proposal.action !== signal.type ||
          proposal.idempotencyKey !== signal.idempotencyKey ||
          stableStringify(proposal.params) !== stableStringify(signal.payload)) {
        throw new Error("Signal does not match its authoritative proposal.");
      }
      if (proposal.status === "executed") return { proposalId: proposal.id, result: proposal.executionResult ?? null };
      const tool = this.toolFor(proposal);
      const outcome = await this.options.proposals.execute(proposal, tool, async (writeTool, input, token) => {
        const result = await executeTool(writeTool, input, {
          tenantId: proposal.tenantId,
          principal: proposal.principal,
          threadId: proposal.threadId,
          turnIndex: 0,
          confirmToken: token,
          confirmationProposalId: proposal.id,
          verifyConfirmation: this.options.proposals.verifyConfirmation.bind(this.options.proposals),
          idempotency: this.options.idempotency,
          audit: this.options.audit ?? (() => {}),
          clock: this.options.clock,
        });
        return result.result;
      });
      if (!outcome.ok) throw new Error(outcome.error ?? "Business action failed.");
      return { proposalId: proposal.id, result: outcome.result };
    });
  }
}
