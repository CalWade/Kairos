import type { MemoryAtom } from "../memory/atom.js";
import { buildDecisionCard, renderDecisionCardFeishuPayload } from "../memory/decisionCard.js";
import { formatRecallAnswer } from "../memory/recallFormatter.js";
import { MemoryStore } from "../memory/store.js";

export type FeishuWorkflowInput = {
  text: string;
  project?: string;
  minScore?: number;
};

export type FeishuWorkflowOutput = {
  ok: boolean;
  action: "push_decision_card" | "answer_with_memory" | "ignore";
  reason: string;
  query: string;
  answer?: string;
  memory_id?: string;
  memory_type?: string;
  card?: unknown;
  matched?: Array<{ id: string; type: string; subject: string; status: string }>;
};

export function runFeishuWorkflow(store: MemoryStore, input: FeishuWorkflowInput): FeishuWorkflowOutput {
  const query = input.text.trim();
  if (!query) return ignore(query, "空消息");
  if (isLikelyNoise(query)) return ignore(query, "低价值闲聊/确认消息");

  const hits = store.search(query, { project: input.project, limit: 5 });
  if (hits.length === 0) return ignore(query, "未命中相关记忆");

  const top = hits[0];
  const score = heuristicMatchScore(query, top);
  if (score < (input.minScore ?? 2)) return ignore(query, "命中强度不足，避免打扰");

  const answer = formatRecallAnswer(query, hits);
  if (top.type === "decision") {
    if (!hasStrongDecisionCue(query, top)) return ignore(query, "未触及该决策的关键选项或反向检索 key，避免误推卡片");
    const card = renderDecisionCardFeishuPayload(buildDecisionCard(top));
    return {
      ok: true,
      action: "push_decision_card",
      reason: "当前讨论触及历史项目决策，建议推送历史决策卡片",
      query,
      answer,
      memory_id: top.id,
      memory_type: top.type,
      card,
      matched: summarizeHits(hits),
    };
  }

  return {
    ok: true,
    action: "answer_with_memory",
    reason: "当前讨论命中历史记忆，但不是 decision 类型",
    query,
    answer,
    memory_id: top.id,
    memory_type: top.type,
    matched: summarizeHits(hits),
  };
}

function ignore(query: string, reason: string): FeishuWorkflowOutput {
  return { ok: true, action: "ignore", reason, query };
}

function isLikelyNoise(text: string): boolean {
  return /^(ok|收到|好|嗯|哈哈|赞|可以|辛苦了)[。.!！]*$/i.test(text.trim()) || text.trim().length < 4;
}

function summarizeHits(hits: MemoryAtom[]) {
  return hits.map((item) => ({ id: item.id, type: item.type, subject: item.subject, status: item.status }));
}

function hasStrongDecisionCue(query: string, atom: MemoryAtom): boolean {
  const needles = decisionNeedles(atom);
  const normalized = query.toLowerCase();
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
}

function decisionNeedles(atom: MemoryAtom): string[] {
  const raw = atom.metadata?.raw_extraction as {
    aliases?: unknown;
    negative_keys?: unknown;
    options_considered?: unknown;
    rejected_options?: unknown;
  } | undefined;
  const values: string[] = [];
  values.push(...atom.tags);
  if (Array.isArray(raw?.aliases)) values.push(...raw.aliases.filter((item): item is string => typeof item === "string"));
  if (Array.isArray(raw?.negative_keys)) values.push(...raw.negative_keys.filter((item): item is string => typeof item === "string"));
  if (Array.isArray(raw?.options_considered)) values.push(...raw.options_considered.filter((item): item is string => typeof item === "string"));
  if (Array.isArray(raw?.rejected_options)) {
    for (const item of raw.rejected_options) {
      if (item && typeof item === "object" && "option" in item && typeof item.option === "string") values.push(item.option);
    }
  }
  return [...new Set(values.map((item) => item.trim()).filter((item) => item.length >= 3 || /^[A-Za-z0-9+#.-]{2,}$/.test(item)))];
}

function heuristicMatchScore(query: string, atom: MemoryAtom): number {
  const haystack = `${atom.subject} ${atom.content} ${atom.tags.join(" ")}`.toLowerCase();
  const tokens = extractTokens(query);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token.toLowerCase())) score += token.length >= 4 ? 2 : 1;
  }
  if (/为什么|要不|还是|是否|会不会|怎么|原因|之前|历史/.test(query)) score += 1;
  if (atom.type === "decision" && /决定|方案|PostgreSQL|SQLite|MongoDB|JSONL/i.test(query)) score += 1;
  return score;
}

function extractTokens(text: string): string[] {
  const latin = text.match(/[A-Za-z0-9_+#.-]{2,}/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const cjkPieces = cjk.flatMap((part) => {
    if (part.length <= 4) return [part];
    const pieces: string[] = [];
    for (let i = 0; i < part.length - 1; i++) pieces.push(part.slice(i, i + 2));
    return pieces;
  });
  return [...new Set([...latin, ...cjkPieces])];
}
