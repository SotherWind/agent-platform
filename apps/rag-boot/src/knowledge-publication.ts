import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface KnowledgePublication {
  tenantId: string;
  documentId: string;
  revision: string;
  generations: string[];
  legacy: boolean;
}

export interface KnowledgePublicationStore {
  readonly durable: boolean;
  get(tenantId: string, documentId: string): KnowledgePublication | undefined;
  list(tenantId: string): KnowledgePublication[];
  publish(next: Omit<KnowledgePublication, "revision">, expectedRevision?: string): KnowledgePublication;
}

export class MemoryKnowledgePublicationStore implements KnowledgePublicationStore {
  readonly durable = false;
  private readonly records = new Map<string, KnowledgePublication>();
  get(tenantId: string, documentId: string) {
    const value = this.records.get(JSON.stringify([tenantId, documentId]));
    return value && structuredClone(value);
  }
  list(tenantId: string) {
    return [...this.records.values()].filter((value) => value.tenantId === tenantId).map((value) => structuredClone(value));
  }
  publish(next: Omit<KnowledgePublication, "revision">, expectedRevision?: string) {
    if (this.get(next.tenantId, next.documentId)?.revision !== expectedRevision) {
      throw new Error("Concurrent knowledge publication; retry using the current revision.");
    }
    const publication = { ...structuredClone(next), revision: randomUUID() };
    this.records.set(JSON.stringify([next.tenantId, next.documentId]), publication);
    return structuredClone(publication);
  }
}

/** One manifest row is the atomic visibility switch for all chunks of a document. */
export class SqliteKnowledgePublicationStore implements KnowledgePublicationStore {
  readonly durable: boolean;
  private readonly db: Database.Database;
  constructor(path: string, private readonly collection = "rag_boot") {
    this.durable = path !== ":memory:" && path !== "";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_publications (
      collection TEXT NOT NULL, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, publication TEXT NOT NULL,
      PRIMARY KEY (collection, tenant_id, document_id)
    )`);
  }
  get(tenantId: string, documentId: string): KnowledgePublication | undefined {
    const row = this.db.prepare("SELECT publication FROM knowledge_publications WHERE collection = ? AND tenant_id = ? AND document_id = ?")
      .get(this.collection, tenantId, documentId) as { publication: string } | undefined;
    return row && JSON.parse(row.publication) as KnowledgePublication;
  }
  list(tenantId: string): KnowledgePublication[] {
    const rows = this.db.prepare("SELECT publication FROM knowledge_publications WHERE collection = ? AND tenant_id = ?")
      .all(this.collection, tenantId) as Array<{ publication: string }>;
    return rows.map((row) => JSON.parse(row.publication) as KnowledgePublication);
  }
  publish(next: Omit<KnowledgePublication, "revision">, expectedRevision?: string): KnowledgePublication {
    return this.db.transaction(() => {
      if (this.get(next.tenantId, next.documentId)?.revision !== expectedRevision) {
        throw new Error("Concurrent knowledge publication; retry using the current revision.");
      }
      const publication = { ...next, revision: randomUUID() };
      this.db.prepare(`INSERT INTO knowledge_publications VALUES (?, ?, ?, ?)
        ON CONFLICT(collection, tenant_id, document_id) DO UPDATE SET publication = excluded.publication`)
        .run(this.collection, next.tenantId, next.documentId, JSON.stringify(publication));
      return structuredClone(publication);
    }).immediate();
  }
  close(): void { this.db.close(); }
}
