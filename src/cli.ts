#!/usr/bin/env node
import { Command } from "commander";
import { MemoryAtomSchema } from "./memory/schema.js";
import { loadSmokeCases, summarizeSmokeCases } from "./eval/smoke.js";

const program = new Command();

program
  .name("memoryops")
  .description("Enterprise long-term collaborative memory engine for Feishu and OpenClaw")
  .version("0.1.0");

program
  .command("add")
  .description("Add a memory candidate from text")
  .option("--text <text>", "text to ingest")
  .action((opts) => {
    console.log(JSON.stringify({ ok: true, command: "add", text: opts.text ?? "" }, null, 2));
  });

program
  .command("search")
  .argument("<query>")
  .description("Search memories")
  .action((query) => {
    console.log(JSON.stringify({ ok: true, command: "search", query, results: [] }, null, 2));
  });

program
  .command("recall")
  .argument("<query>")
  .option("--evidence", "include evidence")
  .description("Recall answer from memories")
  .action((query, opts) => {
    console.log(JSON.stringify({ ok: true, command: "recall", query, evidence: !!opts.evidence }, null, 2));
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
      project: "memoryops",
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
