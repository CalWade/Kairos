/**
 * CLI 命令共用的 helper。业务含义小且横跨多个命令组，统一放这里。
 *
 * 原则：这里的 helper 不应该含业务语义（比如 "跑 eval"、"推卡片" 之类），
 * 只放：存储/IO 封装、env 文件操作、TTY 交互、redact、通用 shape helper。
 */
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import type { CandidateWindow } from "../candidate/window.js";
import type { ConversationThread } from "../candidate/thread.js";
import { createMemoryStore } from "../memory/storeFactory.js";
import type { MemoryStoreLike } from "../memory/storeFactory.js";
import type { toNormalizedMessages } from "../larkCliAdapter.js";

export type StoreOptions = { db?: string; events?: string; store?: string };

export async function storeFromOptions(opts: StoreOptions): Promise<MemoryStoreLike> {
  return createMemoryStore(opts);
}

// ---------- JSON/JSONL 写入 ----------

export function writeJsonl(path: string, items: unknown[], append: boolean) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  writeFileSync(path, body, { encoding: "utf8", flag: append ? "a" : "w" });
}

export function saveEvalOutput(path: string | undefined, output: unknown) {
  if (!path) return;
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2), "utf8");
}

// ---------- .env 文件操作 ----------

export function upsertEnvFile(path: string, values: Record<string, string>) {
  const existing = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const keys = new Set(Object.keys(values));
  const next = existing.filter((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    return !key || !keys.has(key);
  }).filter((line, idx, arr) => line.trim() || idx < arr.length - 1);
  for (const [key, value] of Object.entries(values)) {
    next.push(`${key}=${quoteEnvValue(value)}`);
  }
  writeFileSync(path, `${next.join("\n").trim()}\n`, "utf8");
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

// ---------- 交互 ----------

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function collectLlmConfigInteractively(): Promise<Record<string, string> | undefined> {
  const choice = (await askLine("LLM 配置缺失。现在填写吗？[Y/n] ")).toLowerCase();
  if (choice === "n" || choice === "no" || choice === "skip") return undefined;
  const baseUrl = await askLine("KAIROS_LLM_BASE_URL: ");
  const apiKey = await askLine("KAIROS_LLM_API_KEY: ");
  const model = await askLine("KAIROS_LLM_MODEL: ");
  if (!baseUrl || !apiKey || !model) throw new Error("LLM 配置未填完整；如需跳过，请在提示时输入 n");
  return { KAIROS_LLM_BASE_URL: baseUrl, KAIROS_LLM_API_KEY: apiKey, KAIROS_LLM_MODEL: model };
}

// ---------- 脱敏（用于 silver set 生成） ----------

export function redactText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL>")
    .replace(/https?:\/\/[^\s]+/g, "<URL>")
    .replace(/\b(?:\d{3,4}[- ]?)?\d{7,11}\b/g, "<PHONE>")
    .replace(/(api[_-]?key|token|secret|password|AKIA)[=:：]?\s*[^\s，。]+/gi, "$1=<REDACTED>");
}

// ---------- LLM thread 结果 → CandidateWindow / ConversationThread ----------

type NormalizedMessage = ReturnType<typeof toNormalizedMessages>[number];

type LlmThread = {
  id: string;
  message_ids: string[];
  topic_hint?: string;
  confidence: number;
};

/**
 * 给定 LLM thread linker 的输出，从中挑出和当前窗口 evidence 重叠最多的线程，
 * 重新生成 denoised_text 和 evidence_message_ids。用于 induction 阶段对既有
 * heuristic 窗口做 LLM 精修。
 */
export function refineWindowWithLlmThread(
  window: CandidateWindow,
  messages: NormalizedMessage[],
  llmThreads: LlmThread[],
): CandidateWindow {
  const evidenceSet = new Set(window.evidence_message_ids);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const best = llmThreads
    .map((thread) => ({ thread, overlap: thread.message_ids.filter((id) => evidenceSet.has(id)).length }))
    .sort((a, b) => b.overlap - a.overlap || b.thread.confidence - a.thread.confidence)[0];
  if (!best || best.overlap === 0) return window;
  const selected = best.thread.message_ids
    .map((id) => byId.get(id))
    .filter((m): m is NormalizedMessage => !!m)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!selected.length) return window;
  return {
    ...window,
    denoised_text: selected.map((m) => `${m.sender}：${m.text}`).join("\n"),
    evidence_message_ids: selected.map((m) => m.id),
    topic_hint: best.thread.topic_hint ?? window.topic_hint,
    salience_signals: [...new Set([...window.salience_signals, "llm_thread_linked_context"])],
    dropped_message_ids: messages.filter((m) => !best.thread.message_ids.includes(m.id)).map((m) => m.id),
  };
}

export function conversationThreadsFromLlm(
  messages: NormalizedMessage[],
  llmThreads: LlmThread[],
): ConversationThread[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return llmThreads.map((thread) => {
    const threadMessages = thread.message_ids
      .map((id) => byId.get(id))
      .filter((m): m is NormalizedMessage => !!m)
      .sort((a, b) => a.timestamp - b.timestamp);
    return {
      id: thread.id,
      messages: threadMessages,
      topic_hint: thread.topic_hint,
      participants: [...new Set(threadMessages.map((m) => m.sender))],
      start_time: threadMessages[0]?.timestamp ?? 0,
      end_time: threadMessages[threadMessages.length - 1]?.timestamp ?? 0,
      confidence: thread.confidence,
    };
  }).filter((thread) => thread.messages.length > 0);
}

/**
 * 把真实飞书群消息 + 线程标注转成 thread-linking eval silver set 样本。
 * 自动脱敏消息文本和发送人，用相对 id（m1/user_1）避免暴露真实身份。
 */
export function buildThreadLinkingSilverSample(input: {
  id: string;
  messages: NormalizedMessage[];
  threads: Array<{ id: string; message_ids: string[]; topic_hint?: string; confidence?: number }>;
  labelSource: string;
}) {
  const idMap = new Map(input.messages.map((m, i) => [m.id, `m${i + 1}`]));
  const senderMap = new Map<string, string>();
  const senderAlias = (sender: string) => {
    if (!senderMap.has(sender)) senderMap.set(sender, `user_${senderMap.size + 1}`);
    return senderMap.get(sender)!;
  };
  return {
    id: input.id,
    source: { platform: "feishu", redacted: true, label_source: input.labelSource },
    messages: input.messages.map((m) => ({
      id: idMap.get(m.id),
      sender: senderAlias(m.sender),
      timestamp: m.timestamp,
      text: redactText(m.text),
    })),
    expected_threads: input.threads
      .map((t) => t.message_ids.map((id) => idMap.get(id)).filter(Boolean))
      .filter((ids) => ids.length > 0),
    label_metadata: input.threads.map((t) => ({
      id: t.id,
      topic_hint: t.topic_hint,
      confidence: t.confidence,
      message_ids: t.message_ids.map((id) => idMap.get(id)).filter(Boolean),
    })),
  };
}

export function summarizeActivationActions(actions: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) counts[action] = (counts[action] ?? 0) + 1;
  return counts;
}
