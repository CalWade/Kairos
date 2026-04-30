import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConflictRelation, MemoryAtom } from "./atom.js";
import { EventLog, type MemoryEvent } from "./eventLog.js";
import { makeMemoryId } from "./id.js";
import { MemoryAtomSchema } from "./schema.js";
import type { ReminderOptions, SearchOptions } from "./store.js";

export class JsonlMemoryStore {
  private readonly eventLog: EventLog;
  private readonly eventLogPath: string;

  constructor(_dbPath = "data/memory.jsonl", eventLogPath = "data/memory_events.jsonl") {
    const dir = dirname(eventLogPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.eventLogPath = eventLogPath;
    this.eventLog = new EventLog(eventLogPath);
  }

  upsert(atom: MemoryAtom) {
    const parsed = MemoryAtomSchema.parse(atom);
    this.eventLog.append({
      event_id: makeMemoryId(`${parsed.id}|ADD|${new Date().toISOString()}`),
      action: parsed.action ?? "ADD",
      atom_id: parsed.id,
      at: new Date().toISOString(),
      atom: parsed,
    });
    return parsed;
  }

  supersede(oldId: string, newAtom: MemoryAtom, relation: ConflictRelation = "DIRECT_CONFLICT") {
    const oldAtom = this.get(oldId);
    if (!oldAtom) throw new Error(`旧记忆不存在：${oldId}`);
    const now = new Date().toISOString();
    const validAt = newAtom.valid_at ?? now;
    const updatedOld: MemoryAtom = {
      ...oldAtom,
      status: "superseded",
      invalid_at: oldAtom.invalid_at ?? validAt,
      expired_at: now,
      superseded_by: newAtom.id,
      conflict_relation: relation,
    };
    const updatedNew: MemoryAtom = {
      ...newAtom,
      status: "active",
      action: "SUPERSEDE",
      supersedes: [...new Set([...(newAtom.supersedes ?? []), oldId])],
      conflict_relation: relation,
    };
    this.appendUpdate(updatedOld, "SUPERSEDE_OLD");
    this.appendUpdate(updatedNew, relation, oldId);
    return { old: MemoryAtomSchema.parse(updatedOld), current: MemoryAtomSchema.parse(updatedNew) };
  }

  findConflictCandidates(atom: MemoryAtom, limit = 5): MemoryAtom[] {
    return this.list({ project: atom.project, type: atom.type, scope: atom.scope, limit: 200 })
      .filter((item) => item.id !== atom.id && item.status === "active")
      .map((item) => ({ item, score: overlapScore(atom, item) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  get(id: string): MemoryAtom | undefined {
    return this.snapshot().get(id);
  }

  list(options: SearchOptions = {}): MemoryAtom[] {
    return [...this.snapshot().values()]
      .filter((item) => options.includeHistory || item.status === "active")
      .filter((item) => !options.project || item.project === options.project)
      .filter((item) => !options.type || item.type === options.type)
      .filter((item) => !options.scope || item.scope === options.scope)
      .sort((a, b) => b.importance - a.importance || b.valid_at.localeCompare(a.valid_at))
      .slice(0, options.limit ?? 20);
  }

  search(query: string, options: SearchOptions = {}): MemoryAtom[] {
    const tokens = extractQueryTokens(query);
    return this.list({ ...options, limit: 1000 })
      .map((atom) => ({ atom, score: scoreByTokens(atom, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.atom.importance - a.atom.importance)
      .slice(0, options.limit ?? 10)
      .map((item) => item.atom);
  }

  dueReminders(options: ReminderOptions = {}): MemoryAtom[] {
    const now = options.now ?? new Date().toISOString();
    return this.list({ project: options.project, type: options.type, limit: 1000 })
      .filter((item) => item.status === "active" && item.review_at && item.review_at <= now)
      .sort((a, b) => (a.review_at ?? "").localeCompare(b.review_at ?? "") || b.importance - a.importance)
      .slice(0, options.limit ?? 20);
  }

  ackReminder(id: string, options: { now?: string } = {}): MemoryAtom {
    const atom = this.get(id);
    if (!atom) throw new Error(`记忆不存在：${id}`);
    const now = options.now ?? new Date().toISOString();
    const updated = MemoryAtomSchema.parse({
      ...atom,
      review_at: undefined,
      metadata: { ...(atom.metadata ?? {}), reminder_state: "acked", reminder_acked_at: now },
    });
    this.appendUpdate(updated, "REMINDER_ACK");
    return updated;
  }

  snoozeReminder(id: string, until: string, options: { now?: string } = {}): MemoryAtom {
    const atom = this.get(id);
    if (!atom) throw new Error(`记忆不存在：${id}`);
    const now = options.now ?? new Date().toISOString();
    const updated = MemoryAtomSchema.parse({
      ...atom,
      review_at: until,
      metadata: { ...(atom.metadata ?? {}), reminder_state: "snoozed", reminder_snoozed_at: now, reminder_snoozed_until: until },
    });
    this.appendUpdate(updated, `REMINDER_SNOOZE:${until}`);
    return updated;
  }

  private appendUpdate(atom: MemoryAtom, reason: string, target_id?: string) {
    this.eventLog.append({
      event_id: makeMemoryId(`${atom.id}|UPDATE|${reason}|${new Date().toISOString()}`),
      action: atom.action ?? "UPDATE",
      atom_id: atom.id,
      target_id,
      at: new Date().toISOString(),
      atom,
      reason,
    });
  }

  private snapshot(): Map<string, MemoryAtom> {
    const map = new Map<string, MemoryAtom>();
    if (!existsSync(this.eventLogPath)) return map;
    for (const line of readFileSync(this.eventLogPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as MemoryEvent;
        if (event.atom) map.set(event.atom.id, MemoryAtomSchema.parse(event.atom));
      } catch {
        // Ignore corrupted lines; event log remains append-only.
      }
    }
    return map;
  }
}

function extractQueryTokens(query: string): string[] {
  const latin = query.match(/[A-Za-z0-9_+#.-]{2,}/g) ?? [];
  const cjk = query.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const cjkPieces = cjk.flatMap((part) => {
    if (part.length <= 4) return [part];
    const pieces: string[] = [];
    for (let i = 0; i < part.length - 1; i++) pieces.push(part.slice(i, i + 2));
    return pieces;
  });
  return [...new Set([...latin, ...cjkPieces].map((item) => item.toLowerCase()))];
}

function scoreByTokens(atom: MemoryAtom, tokens: string[]): number {
  const haystack = `${atom.subject} ${atom.content} ${atom.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += token.length >= 4 ? 2 : 1;
  return score + atom.confidence + atom.importance / 10;
}

function overlapScore(a: MemoryAtom, b: MemoryAtom): number {
  const aTokens = new Set(extractQueryTokens(`${a.subject} ${a.content}`));
  const bText = `${b.subject} ${b.content}`.toLowerCase();
  let score = 0;
  for (const token of aTokens) if (bText.includes(token)) score += token.length >= 4 ? 2 : 1;
  if (a.subject && a.subject === b.subject) score += 5;
  return score;
}
