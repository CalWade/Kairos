import { describe, expect, it } from "vitest";
import type { CandidateWindow } from "../src/candidate/window.js";
import { extractDecisionWithLlm, normalizeExtractionResult, parseJsonObject } from "../src/extractor/llmDecisionExtractor.js";

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

  it("should_remember=false 会拒识为 none 并保留 reject_reason", () => {
    const result = normalizeExtractionResult({ kind: "decision", should_remember: false, reject_reason: "未形成稳定结论", confidence: 0.4 }, win());
    expect(result.kind).toBe("none");
    expect(result.reject_reason).toBe("未形成稳定结论");
  });

  it("LLM 非 JSON 首次失败后会重试成功", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const content = calls === 1 ? "not json" : JSON.stringify({ kind: "none", should_remember: false, reject_reason: "闲聊", confidence: 0.3, evidence_message_ids: ["m1"], aliases: [], negative_keys: [], reasoning: "not memory" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await extractDecisionWithLlm(win("收到"), {
      config: { provider: "openai_compatible", baseUrl: "http://fake", apiKey: "k", model: "m" },
      fetchImpl,
      maxAttempts: 2,
    });
    expect(calls).toBe(2);
    expect(result.kind).toBe("none");
    expect(result.extractor_metadata?.attempts).toBe(2);
  });

  it("LLM 连续失败且 fallback=true 会回退规则并记录 degraded", async () => {
    const fetchImpl = (async () => new Response("bad-json", { status: 200 })) as typeof fetch;
    const result = await extractDecisionWithLlm(win("最终决定 MVP 阶段使用 SQLite，不用 PostgreSQL。"), {
      config: { provider: "openai_compatible", baseUrl: "http://fake", apiKey: "k", model: "m" },
      fetchImpl,
      maxAttempts: 2,
      fallback: true,
    });
    expect(result.kind).toBe("decision");
    expect(result.extractor_metadata?.degraded).toBe(true);
    expect(Array.isArray(result.extractor_metadata?.llm_failures)).toBe(true);
  });
});
