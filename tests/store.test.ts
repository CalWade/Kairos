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
});
