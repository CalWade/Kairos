#!/usr/bin/env node
import { Command } from "commander";
import { MemoryAtomSchema } from "./memory/schema.js";
import { createManualMemory } from "./memory/factory.js";
import { MemoryStore } from "./memory/store.js";
import { loadSmokeCases, summarizeSmokeCases } from "./eval/smoke.js";

const program = new Command();

program
  .name("memoryops")
  .description("Kairos: Enterprise long-term collaborative memory engine for Feishu and OpenClaw")
  .version("0.1.0");

function storeFromOptions(opts: { db?: string; events?: string }) {
  return new MemoryStore(opts.db ?? "data/memory.db", opts.events ?? "data/memory_events.jsonl");
}

program
  .command("add")
  .description("添加一条手动记忆，目前用于本地调试和 smoke demo")
  .requiredOption("--text <text>", "要写入的记忆文本")
  .option("--project <project>", "项目名")
  .option("--type <type>", "记忆类型", "knowledge")
  .option("--scope <scope>", "作用域 personal/team/org", "team")
  .option("--subject <subject>", "记忆主题")
  .option("--tag <tag...>", "标签")
  .option("--db <path>", "SQLite 数据库路径")
  .option("--events <path>", "JSONL event log 路径")
  .action((opts) => {
    const atom = createManualMemory({
      text: opts.text,
      project: opts.project,
      type: opts.type,
      scope: opts.scope,
      subject: opts.subject,
      tags: opts.tag ?? [],
    });
    const saved = storeFromOptions(opts).upsert(atom);
    console.log(JSON.stringify({ ok: true, command: "add", atom: saved }, null, 2));
  });

program
  .command("search")
  .argument("<query>")
  .description("搜索记忆")
  .option("--project <project>", "项目名")
  .option("--type <type>", "记忆类型")
  .option("--scope <scope>", "作用域")
  .option("--include-history", "包含 superseded/expired 等历史记忆")
  .option("--limit <limit>", "返回数量", "10")
  .option("--db <path>", "SQLite 数据库路径")
  .option("--events <path>", "JSONL event log 路径")
  .action((query, opts) => {
    const results = storeFromOptions(opts).search(query, {
      project: opts.project,
      type: opts.type,
      scope: opts.scope,
      includeHistory: !!opts.includeHistory,
      limit: Number(opts.limit),
    });
    console.log(JSON.stringify({ ok: true, command: "search", query, total: results.length, results }, null, 2));
  });

program
  .command("recall")
  .argument("<query>")
  .option("--evidence", "包含证据")
  .option("--project <project>", "项目名")
  .option("--db <path>", "SQLite 数据库路径")
  .option("--events <path>", "JSONL event log 路径")
  .description("从记忆中召回答案（当前为检索式 MVP）")
  .action((query, opts) => {
    const results = storeFromOptions(opts).search(query, {
      project: opts.project,
      limit: 5,
    });
    const answer = results.length
      ? `找到 ${results.length} 条相关记忆。最相关：${results[0].content}`
      : "没有找到相关记忆。";
    console.log(JSON.stringify({
      ok: true,
      command: "recall",
      query,
      answer,
      memories: results.map((item) => ({
        id: item.id,
        type: item.type,
        subject: item.subject,
        content: item.content,
        evidence: opts.evidence ? item.source : undefined,
      })),
    }, null, 2));
  });

program
  .command("list")
  .description("列出记忆")
  .option("--project <project>", "项目名")
  .option("--type <type>", "记忆类型")
  .option("--scope <scope>", "作用域")
  .option("--include-history", "包含历史记忆")
  .option("--limit <limit>", "返回数量", "20")
  .option("--db <path>", "SQLite 数据库路径")
  .option("--events <path>", "JSONL event log 路径")
  .action((opts) => {
    const results = storeFromOptions(opts).list({
      project: opts.project,
      type: opts.type,
      scope: opts.scope,
      includeHistory: !!opts.includeHistory,
      limit: Number(opts.limit),
    });
    console.log(JSON.stringify({ ok: true, command: "list", total: results.length, results }, null, 2));
  });

program
  .command("history")
  .argument("<atomId>")
  .description("查看单条记忆详情")
  .option("--db <path>", "SQLite 数据库路径")
  .option("--events <path>", "JSONL event log 路径")
  .action((atomId, opts) => {
    const atom = storeFromOptions(opts).get(atomId);
    console.log(JSON.stringify({ ok: !!atom, command: "history", atom }, null, 2));
  });

program
  .command("remind")
  .option("--now <time>", "mock current time")
  .description("Show due memory reminders")
  .action((opts) => {
    console.log(JSON.stringify({ ok: true, command: "remind", now: opts.now ?? new Date().toISOString(), reminders: [] }, null, 2));
  });

program
  .command("eval")
  .option("--smoke", "run smoke benchmark")
  .description("Run benchmarks")
  .action((opts) => {
    if (opts.smoke) {
      const cases = loadSmokeCases();
      console.log(JSON.stringify({ ok: true, command: "eval", smoke: true, ...summarizeSmokeCases(cases) }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: true, command: "eval", smoke: false, cases: 0 }, null, 2));
  });

program
  .command("schema:check")
  .description("Validate a built-in MemoryAtom sample against the Zod schema")
  .action(() => {
    const now = new Date().toISOString();
    const sample = {
      id: "mem_sample_001",
      type: "decision",
      scope: "team",
      project: "kairos",
      layer: "rule",
      formation: "explicit",
      subject: "database_selection",
      content: "最终决定使用 PostgreSQL，不使用 MongoDB，原因是事务一致性和 SQL 分析能力更好。",
      created_at: now,
      observed_at: now,
      valid_at: now,
      status: "active",
      confidence: 0.92,
      importance: 4,
      source: {
        channel: "manual",
        source_type: "manual_text",
        excerpt: "最终决定使用 PostgreSQL，不使用 MongoDB。",
      },
      tags: ["database", "decision"],
      decay_policy: "step",
      access_count: 0,
    };
    const parsed = MemoryAtomSchema.parse(sample);
    console.log(JSON.stringify({ ok: true, command: "schema:check", atom: parsed }, null, 2));
  });

program.parse();
