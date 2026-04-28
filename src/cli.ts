#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { MemoryAtomSchema } from "./memory/schema.js";
import { createManualMemory } from "./memory/factory.js";
import { MemoryStore } from "./memory/store.js";
import { loadSmokeCases, summarizeSmokeCases } from "./eval/smoke.js";
import { createAtomFromFact, extractFacts, reconcileFact } from "./extractor/mockExtractor.js";
import { normalizeFeishuChatExport } from "./candidate/feishuChatExport.js";

const program = new Command();

program
  .name("memoryops")
  .description("Kairos: Enterprise long-term collaborative memory engine for Feishu and OpenClaw")
  .version("0.1.0");

function storeFromOptions(opts: { db?: string; events?: string }) {
  return new MemoryStore(opts.db ?? "data/memory.db", opts.events ?? "data/memory_events.jsonl");
}




program
  .command("normalize-chat-export")
  .description("将飞书会话导出云文档的 Markdown 标准化为逐条 NormalizedMessage")
  .requiredOption("--file <path>", "Markdown 文件路径")
  .option("--doc-token <token>", "飞书文档 token")
  .option("--chat-id <chatId>", "原始会话 ID")
  .option("--limit <limit>", "输出前 N 条", "20")
  .action((opts) => {
    const markdown = readFileSync(opts.file, "utf8");
    const messages = normalizeFeishuChatExport(markdown, {
      docToken: opts.docToken,
      chatId: opts.chatId,
    });
    console.log(JSON.stringify({
      ok: true,
      command: "normalize-chat-export",
      total: messages.length,
      sample: messages.slice(0, Number(opts.limit)),
    }, null, 2));
  });

program
  .command("ingest")
  .description("通过 mock extractor/reconciler 摄取文本，自动 ADD 或 SUPERSEDE")
  .option("--text <text>", "要摄取的原始文本")
  .option("--file <path>", "从文件读取文本，每个非空行作为一条输入")
  .option("--project <project>", "项目名")
  .option("--db <path>", "SQLite 数据库路径")
  .option("--events <path>", "JSONL event log 路径")
  .action((opts) => {
    if (!opts.text && !opts.file) {
      throw new Error("请提供 --text 或 --file");
    }
    const inputs: string[] = [];
    if (opts.text) inputs.push(opts.text);
    if (opts.file) {
      const fileText = readFileSync(opts.file, "utf8");
      inputs.push(...fileText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }

    const store = storeFromOptions(opts);
    const results = inputs.flatMap((input) => {
      const facts = extractFacts(input, { project: opts.project });
      return facts.map((fact) => {
        const atom = createAtomFromFact(fact);
        const candidates = store.findConflictCandidates(atom);
        const decision = reconcileFact(fact, candidates);
        if (decision.action === "SUPERSEDE" && decision.target_id) {
          const saved = store.supersede(decision.target_id, atom, decision.relation ?? "DIRECT_CONFLICT");
          return { input, fact, decision, saved };
        }
        if (decision.action === "DUPLICATE" || decision.action === "NONE") {
          return { input, fact, decision, saved: null };
        }
        const saved = store.upsert(atom);
        return { input, fact, decision, saved };
      });
    });
    console.log(JSON.stringify({ ok: true, command: "ingest", total: results.length, results }, null, 2));
  });

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
