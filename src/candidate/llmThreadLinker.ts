import type { NormalizedMessage } from "./types.js";
import { chatCompletionsUrl, loadLlmConfig, type LlmConfig } from "../llm/config.js";

export const LLM_THREAD_LINKER_PROMPT_VERSION = "llm-thread-linker-v0.1";

type FetchLike = typeof fetch;

export type LlmThread = {
  id: string;
  message_ids: string[];
  topic_hint?: string;
  confidence: number;
  reasoning?: string;
};

export type LlmThreadLinkResult = {
  ok: boolean;
  degraded: boolean;
  prompt_version: string;
  threads: LlmThread[];
  error?: string;
};

export type LlmThreadLinkOptions = {
  config?: LlmConfig | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxMessages?: number;
};

export async function linkThreadsWithLlm(messages: NormalizedMessage[], options: LlmThreadLinkOptions = {}): Promise<LlmThreadLinkResult> {
  const config = options.config === undefined ? loadLlmConfig() : options.config;
  if (!config) {
    return degraded(messages, "missing_llm_config");
  }
  const limited = messages.slice(0, options.maxMessages ?? 40);
  try {
    const content = await callOpenAICompatible(config, buildPrompt(limited), options.timeoutMs ?? 90_000, options.fetchImpl ?? fetch);
    const parsed = normalizeThreadResult(JSON.parse(extractJsonObject(content)), limited);
    return { ok: true, degraded: false, prompt_version: LLM_THREAD_LINKER_PROMPT_VERSION, threads: parsed };
  } catch (error) {
    return degraded(messages, error instanceof Error ? error.message : String(error));
  }
}

function degraded(messages: NormalizedMessage[], error: string): LlmThreadLinkResult {
  return {
    ok: false,
    degraded: true,
    prompt_version: LLM_THREAD_LINKER_PROMPT_VERSION,
    error,
    threads: [{
      id: "degraded_all_messages",
      message_ids: messages.map((m) => m.id),
      topic_hint: "degraded_fallback",
      confidence: 0.2,
      reasoning: "LLM thread linking failed; keep original message set for conservative downstream handling",
    }],
  };
}

function buildPrompt(messages: NormalizedMessage[]): string {
  return JSON.stringify({
    task: "conversation_thread_linking",
    prompt_version: LLM_THREAD_LINKER_PROMPT_VERSION,
    instructions: [
      "把交错群聊消息分成若干讨论线程。",
      "只使用给定 message_id；不要编造消息。",
      "短确认、指代语、收束语应归到其回复的讨论线程；无法判断时单独成线程或低置信。",
      "输出 JSON：{threads:[{id,message_ids,topic_hint,confidence,reasoning}]}",
    ],
    messages: messages.map((m) => ({ id: m.id, sender: m.sender, timestamp: m.timestamp, text: m.text, thread_id: m.thread_id, reply_to: m.reply_to })),
  });
}

async function callOpenAICompatible(config: LlmConfig, prompt: string, timeoutMs: number, fetchImpl: FetchLike): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "你是 Kairos 的会话解缠器。只返回 JSON 对象，不要 Markdown。" },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty_llm_response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const raw = fenced ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("LLM response is not JSON object");
  return raw.slice(start, end + 1);
}

function normalizeThreadResult(value: unknown, messages: NormalizedMessage[]): LlmThread[] {
  const known = new Set(messages.map((m) => m.id));
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as { threads?: unknown } : {};
  const rawThreads = Array.isArray(input.threads) ? input.threads : [];
  const result: LlmThread[] = [];
  for (let i = 0; i < rawThreads.length; i++) {
    const raw = rawThreads[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const ids = Array.isArray(obj.message_ids) ? obj.message_ids.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
    if (!ids.length) continue;
    result.push({
      id: typeof obj.id === "string" && obj.id.trim() ? obj.id : `llm_thread_${i}`,
      message_ids: [...new Set(ids)],
      topic_hint: typeof obj.topic_hint === "string" ? obj.topic_hint : undefined,
      confidence: clamp(typeof obj.confidence === "number" ? obj.confidence : 0.5),
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
    });
  }
  return result.length ? result : [{ id: "llm_empty_fallback", message_ids: messages.map((m) => m.id), confidence: 0.2, topic_hint: "empty_fallback" }];
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
