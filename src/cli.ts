#!/usr/bin/env node
import { Command } from "commander";

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
    console.log(JSON.stringify({ ok: true, command: "eval", smoke: !!opts.smoke, cases: 0 }, null, 2));
  });

program.parse();
