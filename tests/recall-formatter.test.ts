import { describe, expect, it } from "vitest";
import type { MemoryAtom } from "../src/memory/atom.js";
import { createManualMemory } from "../src/memory/factory.js";
import { formatRecallAnswer } from "../src/memory/recallFormatter.js";

describe("formatRecallAnswer", () => {
  it("将决策记忆格式化为可读回答", () => {
    const atom: MemoryAtom = {
      ...createManualMemory({
        text: "决策：MVP 使用 SQLite\n理由：部署轻",
        project: "kairos",
        type: "decision",
        subject: "local_storage_selection",
      }),
      metadata: {
        raw_extraction: {
          kind: "decision",
          topic: "local_storage_selection",
          decision: "MVP 使用 SQLite",
          reasons: ["部署轻"],
          rejected_options: [{ option: "PostgreSQL", reason: "部署成本高" }],
        },
      },
    };

    const answer = formatRecallAnswer("为什么不用 PostgreSQL？", [atom]);

    expect(answer).toContain("历史决策：MVP 使用 SQLite");
    expect(answer).toContain("理由：部署轻");
    expect(answer).toContain("被否方案：PostgreSQL（部署成本高）");
    expect(answer).toContain(`memoryops decision-card ${atom.id}`);
  });

  it("无结果时返回稳定空回答", () => {
    expect(formatRecallAnswer("unknown", [])).toBe("没有找到相关记忆。");
  });
});
