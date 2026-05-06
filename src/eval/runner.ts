import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkThreadsWithLlm } from "../candidate/llmThreadLinker.js";
import { threadMessages } from "../candidate/thread.js";
import type { NormalizedMessage } from "../candidate/types.js";
import { extractDecisionWithLlm } from "../extractor/llmDecisionExtractor.js";
import { extractDecisionBaseline } from "../extractor/ruleDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import { createAtomFromFact, extractFacts, reconcileFact } from "../extractor/mockExtractor.js";
import { MemoryStore } from "../memory/store.js";
import { runFeishuWorkflow } from "../workflow/feishuWorkflow.js";
import type { CandidateWindow } from "../candidate/window.js";

export type EvalResult = {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  cases: Array<{ id: string; passed: boolean; reason?: string; actual?: unknown }>;
};

export async function runLlmDecisionExtractionEval(path = "eval/datasets/llm-decision-extraction.jsonl"): Promise<EvalResult> {
  const cases = readJsonl<any>(path);
  const results = [];
  for (const item of cases) {
    try {
      const result = await extractDecisionWithLlmWithRetry(window(item.input));
      const containsOk = (item.expected_contains ?? []).every((needle: string) => JSON.stringify(result).includes(needle));
      const passed = result.kind === item.expected_kind && containsOk;
      results.push({ id: item.id, passed, actual: result, reason: passed ? undefined : "LLM 抽取结果与期望不一致" });
    } catch (error) {
      results.push({ id: item.id, passed: false, reason: `LLM 调用失败：${String(error).slice(0, 200)}` });
    }
  }
  return summarize("llm-decision-extraction", results);
}

export async function runThreadLinkingEval(path = "eval/datasets/thread-linking.jsonl"): Promise<EvalResult & { aggregate: Record<string, unknown> }> {
  const cases = readJsonl<any>(path);
  const results = [];
  const heuristicScores = [] as number[];
  const llmScores = [] as number[];
  for (const item of cases) {
    const messages = item.messages.map((m: any) => normalizeEvalMessage(m));
    const expected = normalizeClusters(item.expected_threads);
    const heuristic = normalizeClusters(threadMessages(messages).map((t) => t.messages.map((m) => m.id)));
    const llmResult = await linkThreadsWithLlm(messages, {
      config: { provider: "openai_compatible", baseUrl: "https://example.com/v1", apiKey: "test", model: "mock" },
      fetchImpl: mockThreadLinkFetch(item.mock_llm_threads),
    });
    const llm = normalizeClusters(llmResult.threads.map((t) => t.message_ids));
    const heuristicF1 = pairwiseF1(expected, heuristic);
    const llmF1 = pairwiseF1(expected, llm);
    heuristicScores.push(heuristicF1);
    llmScores.push(llmF1);
    const passed = llmF1 >= heuristicF1 && llmF1 >= (item.min_llm_f1 ?? 0.9);
    results.push({
      id: item.id,
      passed,
      actual: { expected, heuristic, llm, heuristicF1, llmF1 },
      reason: passed ? undefined : "LLM thread linking 未达到期望或未优于启发式",
    });
  }
  return {
    ...summarize("thread-linking", results),
    aggregate: {
      heuristic_avg_f1: average(heuristicScores),
      llm_avg_f1: average(llmScores),
      delta: average(llmScores) - average(heuristicScores),
    },
  };
}

export function runDecisionExtractionEval(path = "eval/datasets/decision-extraction.jsonl"): EvalResult {
  const cases = readJsonl<any>(path);
  const results = cases.map((item) => {
    const result = extractDecisionBaseline(window(item.input));
    const containsOk = (item.expected_contains ?? []).every((needle: string) => JSON.stringify(result).includes(needle));
    const passed = result.kind === item.expected_kind
      && (!item.expected_topic || ("topic" in result && result.topic === item.expected_topic))
      && containsOk;
    return { id: item.id, passed, actual: result, reason: passed ? undefined : "抽取结果与期望不一致" };
  });
  return summarize("decision-extraction", results);
}

export function runConflictUpdateEval(path = "eval/datasets/conflict-update.jsonl"): EvalResult {
  const cases = readJsonl<any>(path);
  const results = cases.map((item) => withTempStore((store) => {
    const oldFact = extractFacts(item.old, { project: "kairos" })[0];
    const oldAtom = store.upsert(createAtomFromFact(oldFact));
    const newFact = extractFacts(item.new, { project: "kairos" })[0];
    const newAtom = createAtomFromFact(newFact);
    const decision = reconcileFact(newFact, store.findConflictCandidates(newAtom));
    if (decision.action === "SUPERSEDE" && decision.target_id) {
      store.supersede(decision.target_id, newAtom, decision.relation ?? "DIRECT_CONFLICT");
    }
    const hits = store.search(item.query, { project: "kairos" });
    const history = store.search(item.query, { project: "kairos", includeHistory: true });
    const currentOk = hits.some((hit) => hit.content.includes(item.expected_current_contains));
    const oldOk = history.some((hit) => hit.id === oldAtom.id && hit.status === item.expected_old_status);
    const relationOk = !item.expected_relation || hits.some((hit) => hit.conflict_relation === item.expected_relation);
    const passed = currentOk && oldOk && relationOk;
    return { id: item.id, passed, actual: { hits, history }, reason: passed ? undefined : "当前值或旧记忆状态不符合期望" };
  }));
  return summarize("conflict-update", results);
}

export function runAntiInterferenceEval(path = "eval/datasets/anti-interference.jsonl"): EvalResult {
  const cases = readJsonl<any>(path);
  const results = cases.map((item) => withTempStore((store) => {
    for (const memory of item.memories) {
      const extraction = extractDecisionBaseline(window(memory));
      const atom = extractionToMemoryAtom(extraction, window(memory), "kairos");
      if (atom) store.upsert(atom);
    }
    // 取 Top-K（默认 5），便于评估排名。旧 case 里 expected_contains 基于 Top1，
    // 仍向后兼容：第一条 hit 为主要判定对象。
    const topK = Math.max(5, item.expected_hit_rank ?? 1);
    const hits = store.search(item.query, { project: "kairos", limit: topK });
    const top1 = hits[0];
    const text = top1 ? top1.content : "";
    const containsOk = (item.expected_contains ?? []).every((needle: string) => text.includes(needle));
    const notContainsOk = (item.expected_not_contains ?? []).every((needle: string) => !text.includes(needle));
    // 硬核模式：若 case 指定 expected_hit_rank，验证目标出现在前 N 位，
    // 同时返回命中位置 hit_rank 方便可视化。
    let hitRank: number | undefined;
    if (item.expected_hit_rank !== undefined) {
      const idx = hits.findIndex((hit) => (item.expected_contains ?? []).every((needle: string) => hit.content.includes(needle)));
      hitRank = idx >= 0 ? idx + 1 : undefined;
    }
    const rankOk = item.expected_hit_rank === undefined || (hitRank !== undefined && hitRank <= item.expected_hit_rank);
    const passed = containsOk && notContainsOk && rankOk;
    return {
      id: item.id,
      passed,
      actual: {
        top1,
        hit_rank: hitRank,
        candidates_in_store: item.memories.length,
        top_k_returned: hits.length,
      },
      reason: passed ? undefined : `抗干扰召回未命中期望或排名不足：hit_rank=${hitRank}, expected≤${item.expected_hit_rank ?? 1}`,
    };
  }));
  return summarize("anti-interference", results);
}

export function runRemindEval(path = "eval/datasets/remind.jsonl"): EvalResult {
  const cases = readJsonl<any>(path);
  const baseNow = "2026-04-28T00:00:00.000Z";
  const results = cases.map((item) => withTempStore((store) => {
    const extraction = extractDecisionBaseline(window(item.memory));
    const atom = extractionToMemoryAtom(extraction, window(item.memory), "kairos", baseNow);
    if (atom) store.upsert(atom);
    const now = addDays(baseNow, item.now_offset_days ?? 0);
    const reminders = store.dueReminders({ project: "kairos", now });
    const text = reminders.map((hit) => hit.content).join("\n");
    const totalOk = item.expected_total === undefined || reminders.length === item.expected_total;
    const containsOk = (item.expected_contains ?? []).every((needle: string) => text.includes(needle));
    const passed = totalOk && containsOk;
    return { id: item.id, passed, actual: { now, reminders }, reason: passed ? undefined : "提醒到期结果不符合期望" };
  }));
  return summarize("remind", results);
}

export function runFeishuWorkflowEval(path = "eval/datasets/feishu-workflow.jsonl"): EvalResult {
  const cases = readJsonl<any>(path);
  const results = cases.map((item) => withTempStore((store) => {
    for (const memory of item.memories ?? []) {
      const extraction = extractDecisionBaseline(window(memory));
      const atom = extractionToMemoryAtom(extraction, window(memory), "kairos");
      if (atom) store.upsert(atom);
    }
    const actual = runFeishuWorkflow(store, { project: "kairos", text: item.message });
    const actionOk = actual.action === item.expected_action;
    const containsOk = (item.expected_contains ?? []).every((needle: string) => JSON.stringify(actual).includes(needle));
    const passed = actionOk && containsOk;
    return { id: item.id, passed, actual, reason: passed ? undefined : "飞书工作流动作或内容不符合期望" };
  }));
  return summarize("feishu-workflow", results);
}

export function runRecallEval(path = "eval/datasets/recall.jsonl"): EvalResult {
  const cases = readJsonl<any>(path);
  const results = cases.map((item) => withTempStore((store) => {
    const extraction = extractDecisionBaseline(window(item.memory));
    const atom = extractionToMemoryAtom(extraction, window(item.memory), "kairos");
    if (atom) store.upsert(atom);
    const hits = store.search(item.query, { project: "kairos" });
    const text = hits.map((hit) => hit.content).join("\n");
    const passed = (item.expected_contains ?? []).every((needle: string) => text.includes(needle));
    return { id: item.id, passed, actual: hits, reason: passed ? undefined : "召回内容未包含期望信息" };
  }));
  return summarize("recall", results);
}

export function runAllCoreEvals(): EvalResult[] {
  return [runDecisionExtractionEval(), runConflictUpdateEval(), runRecallEval(), runAntiInterferenceEval(), runRemindEval(), runFeishuWorkflowEval()];
}

function normalizeEvalMessage(m: any): NormalizedMessage {
  return {
    id: String(m.id),
    sender: String(m.sender ?? "unknown"),
    text: String(m.text ?? ""),
    timestamp: Number(m.timestamp ?? 0),
    chat_id: m.chat_id,
    thread_id: m.thread_id,
    reply_to: m.reply_to,
    mentions: [],
    links: [],
    doc_tokens: [],
    task_ids: [],
    source: "feishu_chat",
  };
}

function mockThreadLinkFetch(threads: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ threads }) } }] }), { status: 200 })) as typeof fetch;
}

function normalizeClusters(clusters: string[][]): string[][] {
  return clusters
    .map((cluster) => [...new Set(cluster)].sort())
    .filter((cluster) => cluster.length > 0)
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function pairwiseF1(expected: string[][], actual: string[][]): number {
  const exp = pairSet(expected);
  const act = pairSet(actual);
  if (exp.size === 0 && act.size === 0) return 1;
  let tp = 0;
  for (const p of act) if (exp.has(p)) tp++;
  const precision = act.size === 0 ? 0 : tp / act.size;
  const recall = exp.size === 0 ? 0 : tp / exp.size;
  if (precision + recall === 0) return 0;
  return 2 * precision * recall / (precision + recall);
}

function pairSet(clusters: string[][]): Set<string> {
  const pairs = new Set<string>();
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        pairs.add(`${cluster[i]}::${cluster[j]}`);
      }
    }
  }
  return pairs;
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function window(text: string): CandidateWindow {
  return {
    id: "win_eval",
    segment_id: "seg_eval",
    topic_hint: "eval",
    salience_score: 0.8,
    salience_signals: [],
    candidate_eligible: true,
    denoised_text: text,
    evidence_message_ids: ["eval_message"],
    dropped_message_ids: [],
    estimated_tokens: Math.ceil(text.length / 2),
  };
}

async function extractDecisionWithLlmWithRetry(candidate: CandidateWindow) {
  // LLM eval should measure result quality without letting one slow/invalid response kill the suite.
  // Fallback results are kept in extractor_metadata.degraded so they remain visible in reports.
  return extractDecisionWithLlm(candidate, { fallback: true, timeoutMs: 30_000, maxAttempts: 2 });
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function summarize(suite: string, cases: EvalResult["cases"]): EvalResult {
  const passed = cases.filter((item) => item.passed).length;
  return { suite, total: cases.length, passed, failed: cases.length - passed, cases };
}

function withTempStore<T>(fn: (store: MemoryStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "kairos-eval-"));
  try {
    return fn(new MemoryStore(join(dir, "memory.db"), join(dir, "events.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
