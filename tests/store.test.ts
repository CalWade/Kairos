import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { createManualMemory } from "../src/memory/factory.js";

function withStore(fn: (store: MemoryStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-test-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), join(dir, "events.jsonl"));
    fn(store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MemoryStore", () => {
  it("upsert 后可以通过 search 找回记忆", () => withStore((store) => {
    const atom = createManualMemory({
      text: "最终决定使用 PostgreSQL，不使用 MongoDB，原因是事务一致性和 SQL 分析能力更好。",
      project: "kairos",
      type: "decision",
      subject: "database_selection",
      tags: ["database", "decision"],
    });

    const saved = store.upsert(atom);
    const results = store.search("我们为什么不用 MongoDB？", { project: "kairos" });

    expect(saved.id).toBe(atom.id);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("PostgreSQL");
  }));

  it("supersede 会让旧记忆失效并保留历史", () => withStore((store) => {
    const oldAtom = store.upsert(createManualMemory({
      text: "以后周报每周五发给 Alice。",
      project: "kairos",
      type: "convention",
      subject: "weekly_report_receiver",
    }));

    const newAtom = createManualMemory({
      text: "不对，周报以后发给 Bob，Alice 不再负责这个了。",
      project: "kairos",
      type: "convention",
      subject: "weekly_report_receiver",
    });

    const result = store.supersede(oldAtom.id, newAtom, "DIRECT_CONFLICT");
    const active = store.search("周报发给谁？", { project: "kairos" });
    const history = store.search("周报", { project: "kairos", includeHistory: true });

    expect(result.old.status).toBe("superseded");
    expect(result.old.superseded_by).toBe(result.current.id);
    expect(result.current.supersedes).toContain(oldAtom.id);
    expect(active).toHaveLength(1);
    expect(active[0].content).toContain("Bob");
    expect(history.map((item) => item.status).sort()).toEqual(["active", "superseded"]);
  }));

  it("findConflictCandidates 能找出同 subject 的活跃候选", () => withStore((store) => {
    const oldAtom = store.upsert(createManualMemory({
      text: "以后周报每周五发给 Alice。",
      project: "kairos",
      type: "convention",
      subject: "weekly_report_receiver",
    }));
    const incoming = createManualMemory({
      text: "周报以后发给 Bob。",
      project: "kairos",
      type: "convention",
      subject: "weekly_report_receiver",
    });

    const candidates = store.findConflictCandidates(incoming);

    expect(candidates.map((item) => item.id)).toContain(oldAtom.id);
  }));

  it("dueReminders 只返回 review_at 已到期的活跃记忆", () => withStore((store) => {
    store.upsert(createManualMemory({
      text: "生产环境 API Key 不允许前端直连，必须走服务端代理。",
      project: "kairos",
      type: "risk",
      subject: "api_key_policy",
      importance: 5,
      review_at: "2026-05-01T00:00:00.000Z",
    }));
    store.upsert(createManualMemory({
      text: "预览 PDF 乱码风险下周再复查。",
      project: "kairos",
      type: "risk",
      subject: "preview_independent_ip_requirement",
      importance: 4,
      review_at: "2026-05-10T00:00:00.000Z",
    }));
    store.upsert(createManualMemory({
      text: "普通知识没有复查时间。",
      project: "kairos",
      type: "knowledge",
      subject: "note",
    }));

    const reminders = store.dueReminders({ project: "kairos", now: "2026-05-01T00:00:00.000Z" });

    expect(reminders).toHaveLength(1);
    expect(reminders[0].subject).toBe("api_key_policy");
    expect(reminders[0].review_at).toBe("2026-05-01T00:00:00.000Z");
  }));


  it("ackReminder 会清除 review_at 并让提醒不再到期", () => withStore((store) => {
    const saved = store.upsert(createManualMemory({
      text: "生产环境 API Key 不允许前端直连。",
      project: "kairos",
      type: "risk",
      subject: "api_key_policy",
      review_at: "2026-05-01T00:00:00.000Z",
    }));

    const acked = store.ackReminder(saved.id, { now: "2026-05-01T01:00:00.000Z" });
    const reminders = store.dueReminders({ project: "kairos", now: "2026-05-02T00:00:00.000Z" });

    expect(acked.review_at).toBeUndefined();
    expect(acked.metadata?.reminder_state).toBe("acked");
    expect(reminders).toHaveLength(0);
  }));

  it("snoozeReminder 会移动 review_at", () => withStore((store) => {
    const saved = store.upsert(createManualMemory({
      text: "预览 PDF 乱码风险需要复查。",
      project: "kairos",
      type: "risk",
      subject: "preview_independent_ip_requirement",
      review_at: "2026-05-01T00:00:00.000Z",
    }));

    const snoozed = store.snoozeReminder(saved.id, "2026-05-03T00:00:00.000Z", { now: "2026-05-01T01:00:00.000Z" });
    const before = store.dueReminders({ project: "kairos", now: "2026-05-02T00:00:00.000Z" });
    const after = store.dueReminders({ project: "kairos", now: "2026-05-03T00:00:00.000Z" });

    expect(snoozed.review_at).toBe("2026-05-03T00:00:00.000Z");
    expect(snoozed.metadata?.reminder_state).toBe("snoozed");
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(1);
  }));

});
