import { describe, expect, it } from "vitest";
import type { MemoryAtom } from "../src/memory/atom.js";
import { buildDecisionCard, renderDecisionCardMarkdown } from "../src/memory/decisionCard.js";
import { createManualMemory } from "../src/memory/factory.js";

describe("Decision Card", () => {
  it("从决策 MemoryAtom 渲染历史决策卡片", () => {
    const atom: MemoryAtom = {
      ...createManualMemory({
        text: "决策：MVP 阶段使用 SQLite\n结论：先用 SQLite\n理由：部署轻；评委容易运行",
        project: "kairos",
        type: "decision",
        subject: "local_storage_selection",
      }),
      source: {
        channel: "manual",
        source_type: "manual_text",
        chunk_ids: ["m1"],
        excerpt: "最终决定 MVP 阶段使用 SQLite，PostgreSQL 部署成本太高。",
      },
      metadata: {
        raw_extraction: {
          kind: "decision",
          topic: "local_storage_selection",
          decision: "MVP 阶段使用 SQLite",
          conclusion: "先用 SQLite",
          reasons: ["部署轻", "评委容易运行"],
          rejected_options: [{ option: "PostgreSQL", reason: "部署成本太高" }],
          opposition: [{ speaker: "王五", content: "PostgreSQL 对 demo 太重" }],
          stage: "MVP",
        },
      },
    };

    const card = buildDecisionCard(atom);
    const markdown = renderDecisionCardMarkdown(card);

    expect(card.decision).toBe("MVP 阶段使用 SQLite");
    expect(card.rejected_options[0]).toEqual({ option: "PostgreSQL", reason: "部署成本太高" });
    expect(markdown).toContain("## 历史决策卡片：local_storage_selection");
    expect(markdown).toContain("### 被否方案");
    expect(markdown).toContain("PostgreSQL：部署成本太高");
    expect(markdown).toContain("摘录：最终决定 MVP 阶段使用 SQLite");
  });

  it("没有 raw_extraction 时从 content 兜底生成卡片", () => {
    const atom = createManualMemory({
      text: "决策：保留 JSONL Event Log\n理由：可审计；方便回放",
      project: "kairos",
      type: "decision",
      subject: "event_log",
    });

    const card = buildDecisionCard(atom);

    expect(card.decision).toBe("保留 JSONL Event Log");
    expect(card.reasons).toEqual(["可审计", "方便回放"]);
  });
});
