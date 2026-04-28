import { describe, expect, it } from "vitest";
import type { CandidateWindow } from "../src/candidate/window.js";
import { normalizeExtractionResult, parseJsonObject } from "../src/extractor/llmDecisionExtractor.js";

function win(text = "demo"): CandidateWindow {
  return {
    id: "win_test",
    segment_id: "seg_test",
    topic_hint: "test",
    salience_score: 0.8,
    salience_signals: [],
    candidate_eligible: true,
    denoised_text: text,
    evidence_message_ids: ["m1"],
    dropped_message_ids: [],
    estimated_tokens: 10,
  };
}

describe("LLMDecisionExtractor helpers", () => {
  it("parseJsonObject 能处理 fenced JSON", () => {
    const parsed = parseJsonObject("```json\n{\"kind\":\"none\"}\n```");
    expect(parsed).toEqual({ kind: "none" });
  });

  it("normalizeExtractionResult 将 LLM JSON 归一化为 decision schema", () => {
    const result = normalizeExtractionResult({
      kind: "decision",
      confidence: 1.2,
      topic: "database_selection",
      decision: "MVP 使用 SQLite",
      options_considered: ["SQLite", "PostgreSQL", 1],
      reasons: ["部署轻"],
      rejected_options: [{ option: "PostgreSQL", reason: "部署重" }],
      opposition: [{ speaker: "王五", content: "PostgreSQL 太重" }],
      conclusion: "先用 SQLite",
      aliases: ["数据库"],
      negative_keys: ["为什么不用 PostgreSQL"],
    }, win());

    expect(result.kind).toBe("decision");
    if (result.kind !== "decision") return;
    expect(result.confidence).toBe(1);
    expect(result.evidence_message_ids).toEqual(["m1"]);
    expect(result.options_considered).toEqual(["SQLite", "PostgreSQL"]);
    expect(result.rejected_options[0].option).toBe("PostgreSQL");
  });

  it("未知 kind 会归一化为 none", () => {
    const result = normalizeExtractionResult({ kind: "other", confidence: 0.5 }, win());
    expect(result.kind).toBe("none");
  });
});
