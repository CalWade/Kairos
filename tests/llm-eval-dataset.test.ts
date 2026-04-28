import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("llm eval dataset", () => {
  it("包含显式 LLM 评测样本但不进入 core eval", () => {
    const lines = readFileSync("eval/datasets/llm-decision-extraction.jsonl", "utf8").trim().split("\n");
    const cases = lines.map((line) => JSON.parse(line));

    expect(cases.length).toBeGreaterThanOrEqual(4);
    expect(cases.map((item) => item.expected_kind)).toContain("none");
    expect(cases.some((item) => item.input.includes("normalize-chat-export"))).toBe(true);
  });
});
