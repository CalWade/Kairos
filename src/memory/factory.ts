import type { MemoryAtom, MemoryType, MemoryScope, MemoryLayer, MemoryFormation, DecayPolicy } from "./atom.js";
import { makeMemoryId } from "./id.js";

export type CreateMemoryInput = {
  text: string;
  project?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  layer?: MemoryLayer;
  formation?: MemoryFormation;
  subject?: string;
  tags?: string[];
  importance?: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
  decay_policy?: DecayPolicy;
  now?: string;
};

function inferSubject(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 32 ? compact.slice(0, 32) : compact || "untitled";
}

export function createManualMemory(input: CreateMemoryInput): MemoryAtom {
  const now = input.now ?? new Date().toISOString();
  const idSeed = [input.project ?? "default", input.text, now].join("|");
  return {
    id: makeMemoryId(idSeed),
    type: input.type ?? "knowledge",
    scope: input.scope ?? "team",
    project: input.project,
    layer: input.layer ?? "knowledge",
    formation: input.formation ?? "explicit",
    subject: input.subject ?? inferSubject(input.text),
    content: input.text,
    created_at: now,
    observed_at: now,
    valid_at: now,
    status: "active",
    confidence: input.confidence ?? 0.8,
    importance: input.importance ?? 3,
    source: {
      channel: "manual",
      source_type: "manual_text",
      excerpt: input.text,
    },
    tags: input.tags ?? [],
    decay_policy: input.decay_policy ?? "step",
    access_count: 0,
  };
}
