import { JsonlMemoryStore } from "./jsonlStore.js";
import type { MemoryStore } from "./store.js";

export type StoreKind = "sqlite" | "jsonl";

export type MemoryStoreLike = Pick<MemoryStore,
  | "upsert"
  | "supersede"
  | "findConflictCandidates"
  | "get"
  | "list"
  | "search"
  | "dueReminders"
  | "ackReminder"
  | "snoozeReminder"
>;

export async function createMemoryStore(options: { db?: string; events?: string; store?: string } = {}): Promise<MemoryStoreLike> {
  const kind = normalizeStoreKind(options.store ?? process.env.KAIROS_STORE);
  if (kind === "jsonl") {
    return new JsonlMemoryStore(options.db ?? "data/memory.jsonl", options.events ?? "data/memory_events.jsonl");
  }
  const { MemoryStore } = await import("./store.js");
  return new MemoryStore(options.db ?? "data/memory.db", options.events ?? "data/memory_events.jsonl");
}

export function createMemoryStoreSyncForJsonl(options: { db?: string; events?: string; store?: string } = {}): MemoryStoreLike {
  const kind = normalizeStoreKind(options.store ?? process.env.KAIROS_STORE);
  if (kind !== "jsonl") throw new Error("Synchronous store creation is only available for jsonl");
  return new JsonlMemoryStore(options.db ?? "data/memory.jsonl", options.events ?? "data/memory_events.jsonl");
}

export function normalizeStoreKind(value?: string): StoreKind {
  return value === "sqlite" ? "sqlite" : "jsonl";
}
