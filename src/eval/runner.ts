import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDecisionBaseline } from "../extractor/ruleDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import { createAtomFromFact, extractFacts, reconcileFact } from "../extractor/mockExtractor.js";
import { MemoryStore } from "../memory/store.js";
import type { CandidateWindow } from "../candidate/window.js";

export type EvalResult = {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  cases: Array<{ id: string; passed: boolean; reason?: string; actual?: unknown }>;
};

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
    const hits = store.search(item.query, { project: "kairos", limit: 1 });
    const text = hits.map((hit) => hit.content).join("\n");
    const containsOk = (item.expected_contains ?? []).every((needle: string) => text.includes(needle));
    const notContainsOk = (item.expected_not_contains ?? []).every((needle: string) => !text.includes(needle));
    const passed = containsOk && notContainsOk;
    return { id: item.id, passed, actual: hits, reason: passed ? undefined : "抗干扰召回未命中期望或命中了不相关内容" };
  }));
  return summarize("anti-interference", results);
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
  return [runDecisionExtractionEval(), runConflictUpdateEval(), runRecallEval(), runAntiInterferenceEval()];
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
