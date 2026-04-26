import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryAtom, MemoryAction } from "./atom.js";

export type MemoryEvent = {
  event_id: string;
  action: MemoryAction;
  atom_id: string;
  at: string;
  atom?: MemoryAtom;
  target_id?: string;
  reason?: string;
};

export class EventLog {
  constructor(private readonly path = "data/memory_events.jsonl") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(event: MemoryEvent) {
    appendFileSync(this.path, JSON.stringify(event, null, 0) + "\n", "utf8");
  }

  readAll(): MemoryEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryEvent);
  }
}
