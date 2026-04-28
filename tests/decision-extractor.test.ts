import { describe, expect, it } from "vitest";
import type { CandidateWindow } from "../src/candidate/window.js";
import { extractDecisionBaseline } from "../src/extractor/ruleDecisionExtractor.js";

function win(text: string): CandidateWindow {
  return {
    id: "win_test",
    segment_id: "seg_test",
    topic_hint: "test",
    salience_score: 0.8,
    salience_signals: [],
    candidate_eligible: true,
    denoised_text: text,
    evidence_message_ids: ["m1", "m2"],
    dropped_message_ids: [],
    estimated_tokens: 10,
  };
}

describe("extractDecisionBaseline", () => {
  it("抽取数据库选型决策", () => {
    const result = extractDecisionBaseline(win(`张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。
王五：PostgreSQL 对复赛 demo 来说部署成本太高，容易让评委跑不起来。`));

    expect(result.kind).toBe("decision");
    if (result.kind !== "decision") return;
    expect(result.topic).toBe("local_storage_selection");
    expect(result.decision).toContain("SQLite");
    expect(result.rejected_options[0].option).toBe("PostgreSQL");
    expect(result.aliases).toContain("数据库选型");
  });

  it("抽取预览独立 IP 风险", () => {
    const result = extractDecisionBaseline(win(`韦贺文：现在是遇到这个bug
韦贺文：给了三次 ip，两次 都不对
黄威健：这个要给独立ip
黄威健：有点问题，预览pdf有中文乱码`));

    expect(result.kind).toBe("risk");
    if (result.kind !== "risk") return;
    expect(result.topic).toBe("preview_independent_ip_requirement");
    expect(result.risk).toContain("独立 IP");
    expect(result.aliases).toContain("中文乱码");
  });

  it("低价值窗口返回 none", () => {
    const result = extractDecisionBaseline(win("黄威健：ok\n韦贺文：哈哈"));
    expect(result.kind).toBe("none");
  });
});
