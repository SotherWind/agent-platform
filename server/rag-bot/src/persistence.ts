import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EntryIdempotencyStore, SqliteEntryIdempotencyStore,
  InMemoryIdempotencyStore, SqliteIdempotencyStore,
  InMemoryTicketStore, SqliteTicketStore,
  InMemoryActionSignalStore, SqliteActionSignalStore,
  MemoryProposalStore, SqliteProposalStore,
  MemorySessionBindingStore, SqliteSessionBindingStore,
  MemoryKnowledgePublicationStore, SqliteKnowledgePublicationStore,
  SqliteSaver,
} from "@agent-platform/rag-boot";
import { LocalCrmAdapter } from "./crm.js";

/** A single local database; all processes for this deployment must share it. */
export function createPersistence(dataDir?: string, options: { localCrm?: boolean } = {}) {
  const opened: Array<{ close(): void }> = [];
  const track = <T extends { close(): void }>(resource: T): T => {
    opened.push(resource);
    return resource;
  };
  const close = () => {
    for (const resource of opened.splice(0).reverse()) resource.close();
  };
  if (dataDir) mkdirSync(resolve(dataDir), { recursive: true });
  const path = dataDir ? join(resolve(dataDir), "ragbot.sqlite") : undefined;
  try {
    const persistence = {
      checkpointer: path ? track(new SqliteSaver({ path })) : undefined,
      entry: path ? track(new SqliteEntryIdempotencyStore({ path })) : new EntryIdempotencyStore(),
      tools: path ? track(new SqliteIdempotencyStore({ path })) : new InMemoryIdempotencyStore(),
      tickets: path ? track(new SqliteTicketStore(path)) : new InMemoryTicketStore(),
      signals: path ? track(new SqliteActionSignalStore(path)) : new InMemoryActionSignalStore(),
      proposals: path ? track(new SqliteProposalStore(path)) : new MemoryProposalStore(),
      sessions: path ? track(new SqliteSessionBindingStore(path)) : new MemorySessionBindingStore(),
      publications: path ? track(new SqliteKnowledgePublicationStore(path, process.env.QDRANT_COLLECTION_NAME ?? "rag_boot"))
        : new MemoryKnowledgePublicationStore(),
      close,
    };
    return options.localCrm === false
      ? persistence
      : { ...persistence, crm: track(new LocalCrmAdapter({ path: path ?? ":memory:" })) };
  } catch (error) {
    close();
    throw error;
  }
}
