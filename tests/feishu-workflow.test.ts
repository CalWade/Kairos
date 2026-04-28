import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { createManualMemory } from "../src/memory/factory.js";
import { runFeishuWorkflow } from "../src/workflow/feishuWorkflow.js";

function withStore(fn: (store: MemoryStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-workflow-"));
  try {
    fn(new MemoryStore(join(dir, "memory.db"), join(dir, "events.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runFeishuWorkflow", () => {
  it("命中历史决策时建议推送决策卡片", () => withStore((store) => {
    const atom = store.upsert(createManualMemory({
      text: "决策：MVP 阶段使用 SQLite\n理由：PostgreSQL 部署成本高",
      project: "kairos",
      type: "decision",
      subject: "local_storage_selection",
      tags: ["SQLite", "PostgreSQL", "数据库选型"],
    }));

    const result = runFeishuWorkflow(store, { project: "kairos", text: "要不我们还是用 PostgreSQL？" });

    expect(result.action).toBe("push_decision_card");
    expect(result.memory_id).toBe(atom.id);
    expect(JSON.stringify(result.card)).toContain("历史决策卡片");
  }));

  it("低价值闲聊不触发", () => withStore((store) => {
    const result = runFeishuWorkflow(store, { project: "kairos", text: "收到" });
    expect(result.action).toBe("ignore");
  }));
});
