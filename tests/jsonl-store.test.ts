import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManualMemory } from "../src/memory/factory.js";
import { JsonlMemoryStore } from "../src/memory/jsonlStore.js";
import { runFeishuWorkflow } from "../src/workflow/feishuWorkflow.js";

function withJsonlStore(fn: (store: JsonlMemoryStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-jsonl-"));
  try {
    fn(new JsonlMemoryStore(join(dir, "memory.jsonl"), join(dir, "events.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("JsonlMemoryStore", () => {
  it("支持写入、搜索和飞书工作流触发", () => withJsonlStore((store) => {
    const atom = store.upsert(createManualMemory({
      text: "决策：MVP 阶段使用 SQLite\n理由：PostgreSQL 部署成本高",
      project: "kairos",
      type: "decision",
      subject: "local_storage_selection",
      tags: ["SQLite", "PostgreSQL", "数据库选型"],
    }));

    const hits = store.search("为什么不用 PostgreSQL？", { project: "kairos" });
    const workflow = runFeishuWorkflow(store, { project: "kairos", text: "要不我们还是用 PostgreSQL？" });

    expect(hits[0].id).toBe(atom.id);
    expect(workflow.action).toBe("push_decision_card");
  }));

  it("支持 supersede 和提醒生命周期", () => withJsonlStore((store) => {
    const oldAtom = store.upsert(createManualMemory({ text: "以后周报每周五发给 Alice。", project: "kairos", type: "convention", subject: "weekly_report_receiver" }));
    const newAtom = createManualMemory({ text: "不对，周报以后发给 Bob。", project: "kairos", type: "convention", subject: "weekly_report_receiver" });
    const result = store.supersede(oldAtom.id, newAtom);

    const risk = store.upsert(createManualMemory({ text: "API Key 风险", project: "kairos", type: "risk", subject: "api_key_policy", review_at: "2026-05-01T00:00:00.000Z" }));
    expect(store.dueReminders({ project: "kairos", now: "2026-05-01T00:00:00.000Z" })).toHaveLength(1);
    store.snoozeReminder(risk.id, "2026-05-03T00:00:00.000Z");
    expect(store.dueReminders({ project: "kairos", now: "2026-05-02T00:00:00.000Z" })).toHaveLength(0);
    store.ackReminder(risk.id);

    expect(result.old.status).toBe("superseded");
    expect(store.get(risk.id)?.review_at).toBeUndefined();
  }));
});
