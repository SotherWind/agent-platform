import Database from "better-sqlite3";
import type { ActionProposal } from "./proposal";

export interface ProposalStore {
  readonly durable: boolean;
  get(id: string): ActionProposal | undefined;
  insert(proposal: ActionProposal): void;
  /** Synchronous, atomic read/modify/write; the callback must not perform I/O. */
  change(id: string, update: (current: ActionProposal) => ActionProposal): ActionProposal;
  all(): ActionProposal[];
}

export class MemoryProposalStore implements ProposalStore {
  readonly durable = false;
  private readonly records = new Map<string, ActionProposal>();
  get(id: string): ActionProposal | undefined {
    const proposal = this.records.get(id);
    return proposal && structuredClone(proposal);
  }
  insert(proposal: ActionProposal): void {
    if (this.records.has(proposal.id)) throw new Error("Proposal already exists.");
    this.records.set(proposal.id, structuredClone(proposal));
  }
  change(id: string, update: (current: ActionProposal) => ActionProposal): ActionProposal {
    const current = this.get(id);
    if (!current) throw new Error("Proposal not found.");
    const next = update(current);
    this.records.set(id, structuredClone(next));
    return structuredClone(next);
  }
  all(): ActionProposal[] { return [...this.records.values()].map((p) => structuredClone(p)); }
}

export class SqliteProposalStore implements ProposalStore {
  readonly durable: boolean;
  private readonly db: Database.Database;
  constructor(path: string) {
    this.durable = path !== ":memory:" && path !== "";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS action_proposals (id TEXT PRIMARY KEY, proposal TEXT NOT NULL)");
  }
  get(id: string): ActionProposal | undefined {
    const row = this.db.prepare("SELECT proposal FROM action_proposals WHERE id = ?")
      .get(id) as { proposal: string } | undefined;
    return row ? JSON.parse(row.proposal) as ActionProposal : undefined;
  }
  insert(proposal: ActionProposal): void {
    this.db.prepare("INSERT INTO action_proposals VALUES (?, ?)").run(proposal.id, JSON.stringify(proposal));
  }
  change(id: string, update: (current: ActionProposal) => ActionProposal): ActionProposal {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error("Proposal not found.");
      const next = update(current);
      this.db.prepare("UPDATE action_proposals SET proposal = ? WHERE id = ?").run(JSON.stringify(next), id);
      return structuredClone(next);
    }).immediate();
  }
  all(): ActionProposal[] {
    return (this.db.prepare("SELECT proposal FROM action_proposals").all() as Array<{ proposal: string }>)
      .map((row) => JSON.parse(row.proposal) as ActionProposal);
  }
  close(): void { this.db.close(); }
}
