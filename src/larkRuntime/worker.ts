import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildCandidateWindowFromThread, type CandidateWindow } from "../candidate/window.js";
import { linkThreadsWithLlm } from "../candidate/llmThreadLinker.js";
import { threadMessages, type ConversationThread } from "../candidate/thread.js";
import type { NormalizedMessage } from "../candidate/types.js";
import { extractDecisionWithLlm } from "../extractor/llmDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import { sendFeishuInteractiveWebhook } from "../feishuWebhook.js";
import { InductionQueue } from "../induction/queue.js";
import { runLarkCliJson, toNormalizedMessages } from "../larkCliAdapter.js";
import { reconcileAndApplyMemoryAtom } from "../memory/reconcile.js";
import type { MemoryStoreLike } from "../memory/storeFactory.js";
import { ActivationThrottle } from "../workflow/activationThrottle.js";
import { runFeishuWorkflow } from "../workflow/feishuWorkflow.js";

export type LarkRuntimeOptions = {
  chatId: string;
  chatName?: string;
  profile?: string;
  project?: string;
  pageSize?: number;
  intervalMs?: number;
  once?: boolean;
  sendFeishuWebhook?: boolean;
  feishuWebhookUrl?: string;
  statePath?: string;
  runtimeLogPath?: string;
  inductionQueuePath?: string;
  activationThrottlePath?: string;
  cooldownMs?: number;
  llmThreadLink?: boolean;
  fallback?: boolean;
  store: MemoryStoreLike;
};

export type LarkRuntimeState = {
  processed_message_ids: string[];
  last_cycle_at?: string;
};

export type LarkRuntimeCycleResult = {
  ok: boolean;
  at: string;
  chat_id: string;
  chat_name?: string;
  chat_label: string;
  fetched: number;
  new_messages: number;
  enqueued: number;
  induction_processed: number;
  activations: Record<string, number>;
  sent_total: number;
  errors: string[];
};

export async function runLarkRuntime(options: LarkRuntimeOptions): Promise<void> {
  validateRuntimeOptions(options);
  do {
    const result = await runLarkRuntimeCycle(options);
    console.log(JSON.stringify({ ok: true, command: "lark-runtime cycle", result }, null, 2));
    if (options.once) return;
    await sleep(options.intervalMs ?? 10_000);
  } while (true);
}

export async function runLarkRuntimeCycle(options: LarkRuntimeOptions): Promise<LarkRuntimeCycleResult> {
  validateRuntimeOptions(options);
  const at = new Date().toISOString();
  const errors: string[] = [];
  const statePath = options.statePath ?? "data/lark_runtime_state.json";
  const state = readRuntimeState(statePath);
  const processed = new Set(state.processed_message_ids);

  const args = ["im", "+chat-messages-list", "--chat-id", options.chatId, "--format", "json", "--page-size", String(options.pageSize ?? 20)];
  if (options.profile) args.push("--profile", options.profile);
  const raw = runLarkCliJson(args);
  const messages = toNormalizedMessages(raw, options.chatId).sort((a, b) => a.timestamp - b.timestamp);
  const newMessages = messages.filter((m) => !processed.has(m.id));

  const queue = new InductionQueue(options.inductionQueuePath ?? "data/induction_queue.jsonl");
  let enqueued = 0;
  if (newMessages.length) {
    const threads = threadMessages(messages);
    const windows = threads.map((thread) => buildCandidateWindowFromThread(thread));
    for (const win of windows) {
      if (!win.has_resolution_cue && win.salience_score < 5) continue;
      const legacy = toLegacyWindow(win);
      queue.enqueue(legacy, { project: options.project, contextMessages: messages });
      enqueued++;
    }
  }

  let inductionProcessed = 0;
  for (const job of queue.list({ status: "pending", limit: 5 })) {
    try {
      const threadLink = options.llmThreadLink && job.context_messages?.length ? await linkThreadsWithLlm(job.context_messages, { timeoutMs: 120_000 }) : undefined;
      const window = threadLink && !threadLink.degraded ? refineWindowWithLlmThread(job.window, job.context_messages ?? [], threadLink.threads) : job.window;
      const extraction = await extractDecisionWithLlm(window, { fallback: options.fallback ?? true });
      const atom = extractionToMemoryAtom(extraction, window, job.project ?? options.project);
      const reconcile = atom ? reconcileAndApplyMemoryAtom(options.store, atom) : { action: "NONE", reason: "extractor_returned_none" };
      queue.markDone(job, { extraction, atom, reconcile, thread_linker: threadLink ? { degraded: threadLink.degraded, error: threadLink.error } : undefined });
      inductionProcessed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`induction:${job.id}:${msg}`);
      queue.markFailed(job, msg);
    }
  }

  const throttle = new ActivationThrottle(options.activationThrottlePath ?? "data/activation_throttle.jsonl");
  const activationCounts: Record<string, number> = {};
  let sentTotal = 0;
  for (const message of newMessages) {
    try {
      const activation = runFeishuWorkflow(options.store, { text: message.text, project: options.project });
      activationCounts[activation.action] = (activationCounts[activation.action] ?? 0) + 1;
      if (activation.action === "push_decision_card" && activation.card && activation.memory_id) {
        const throttleDecision = throttle.check({ chat_id: options.chatId, memory_id: activation.memory_id, cooldownMs: options.cooldownMs ?? 900_000 });
        if (options.sendFeishuWebhook && options.feishuWebhookUrl && throttleDecision.allowed) {
          const sent = await sendFeishuInteractiveWebhook(options.feishuWebhookUrl, activation.card);
          if (sent.ok) {
            throttle.record({ chat_id: options.chatId, memory_id: activation.memory_id, message_id: message.id });
            sentTotal++;
          } else {
            errors.push(`webhook:${message.id}:${sent.status}:${sent.code ?? ""}:${sent.msg ?? ""}`);
          }
        }
      }
    } catch (error) {
      errors.push(`activation:${message.id}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const m of newMessages) processed.add(m.id);
  writeRuntimeState(statePath, { processed_message_ids: [...processed].slice(-1000), last_cycle_at: at });
  const result = {
    ok: errors.length === 0,
    at,
    chat_id: options.chatId,
    chat_name: options.chatName,
    chat_label: options.chatName ? `${options.chatName} (${options.chatId})` : options.chatId,
    fetched: messages.length,
    new_messages: newMessages.length,
    enqueued,
    induction_processed: inductionProcessed,
    activations: activationCounts,
    sent_total: sentTotal,
    errors,
  };
  appendRuntimeLog(options.runtimeLogPath ?? "runs/lark-runtime.jsonl", result);
  return result;
}

function validateRuntimeOptions(options: LarkRuntimeOptions) {
  if (!options.chatId) throw new Error("缺少 chatId：请传 --chat-id 或设置 KAIROS_CHAT_ID");
  if (options.sendFeishuWebhook && !options.feishuWebhookUrl) throw new Error("启用发送卡片需要 --feishu-webhook 或 KAIROS_FEISHU_WEBHOOK_URL");
}

function toLegacyWindow(win: ReturnType<typeof buildCandidateWindowFromThread>): CandidateWindow {
  return {
    id: win.id,
    segment_id: win.thread_id ?? win.id,
    topic_hint: win.topic_hint ?? "",
    salience_score: win.salience_score,
    salience_signals: win.salience_reasons,
    candidate_eligible: true,
    denoised_text: win.denoised_text,
    evidence_message_ids: win.evidence_message_ids,
    dropped_message_ids: win.dropped_message_ids,
    estimated_tokens: win.estimated_tokens,
    source_channel: "feishu",
    source_type: "feishu_message",
  };
}

function refineWindowWithLlmThread(window: CandidateWindow, messages: NormalizedMessage[], llmThreads: Array<{ id: string; message_ids: string[]; topic_hint?: string; confidence: number }>): CandidateWindow {
  const evidenceSet = new Set(window.evidence_message_ids);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const best = llmThreads
    .map((thread) => ({ thread, overlap: thread.message_ids.filter((id) => evidenceSet.has(id)).length }))
    .sort((a, b) => b.overlap - a.overlap || b.thread.confidence - a.thread.confidence)[0];
  if (!best || best.overlap === 0) return window;
  const selected = best.thread.message_ids.map((id) => byId.get(id)).filter((m): m is NormalizedMessage => !!m).sort((a, b) => a.timestamp - b.timestamp);
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

function readRuntimeState(path: string): LarkRuntimeState {
  if (!existsSync(path)) return { processed_message_ids: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LarkRuntimeState;
    return { processed_message_ids: Array.isArray(parsed.processed_message_ids) ? parsed.processed_message_ids : [], last_cycle_at: parsed.last_cycle_at };
  } catch {
    return { processed_message_ids: [] };
  }
}

function writeRuntimeState(path: string, state: LarkRuntimeState) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

function appendRuntimeLog(path: string, item: unknown) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(item)}\n`, "utf8");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
