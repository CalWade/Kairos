import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { createManualMemory } from "../src/memory/factory.js";
import { buildEngineDashboardData, renderEngineDashboardHtml, writeEngineDashboardHtml } from "../src/visualization/dashboard.js";

describe("Engine Dashboard", () => {
  it("生成包含 MemoryAtom 和工作流步骤的 HTML", () => {
    const dir = mkdtempSync(join(tmpdir(), "kairos-dashboard-"));
    try {
      const store = new MemoryStore(join(dir, "memory.db"), join(dir, "events.jsonl"));
      store.upsert(createManualMemory({ text: "决策：复赛阶段使用 SQLite", project: "kairos", type: "decision", subject: "local_storage_selection" }));
      const evalPath = join(dir, "latest-eval.json");
      const runtimeLogPath = join(dir, "lark-runtime.jsonl");
      writeFileSync(evalPath, JSON.stringify({ at: "2026-05-06T00:00:00.000Z", mode: "core", results: [{ suite: "recall", total: 1, passed: 1, failed: 0 }] }));
      writeFileSync(runtimeLogPath, JSON.stringify({ ok: true, chat_id: "oc_demo", chat_name: "Kairos Demo 群", chat_label: "Kairos Demo 群 (oc_demo)", fetched: 3, new_messages: 1, enqueued: 1, sent_total: 0, activations: { ignore: 1 }, recent_messages: [{ id: "om_1", sender: "Alice", text: "最终决定：复赛阶段使用 SQLite", timestamp: 1715000000000, chat_id: "oc_demo", chat_name: "Kairos Demo 群" }] }) + "\n");
      const data = buildEngineDashboardData({ store, eventsPath: join(dir, "events.jsonl"), inductionQueuePath: join(dir, "induction.jsonl"), refineQueuePath: join(dir, "refine.jsonl"), activationThrottlePath: join(dir, "activation.jsonl"), runtimeLogPath, evalResultPath: evalPath });
      const html = renderEngineDashboardHtml(data);
      expect(html).toContain("Kairos 引擎工作流可视化");
      expect(html).toContain("复赛阶段使用 SQLite");
      expect(html).toContain("飞书消息进入");
      expect(html).toContain("长期记忆生成");
      expect(html).toContain("Kairos Demo 群 (oc_demo)");
      expect(html).toContain("捕获到的真实群聊信息");
      expect(html).toContain("最终决定：复赛阶段使用 SQLite");
      expect(html).toContain("展开原始 runtime 日志");
      expect(html).toContain("本地评测结果");
      expect(html).toContain("recall");
      const output = join(dir, "dashboard.html");
      writeEngineDashboardHtml(data, output);
      expect(renderEngineDashboardHtml(data)).toContain("当前有效记忆");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
