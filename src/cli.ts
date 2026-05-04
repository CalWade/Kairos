#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { MemoryAtomSchema } from "./memory/schema.js";
import { createManualMemory } from "./memory/factory.js";
import { createMemoryStore } from "./memory/storeFactory.js";
import { loadSmokeCases, summarizeSmokeCases } from "./eval/smoke.js";
import { runAllCoreEvals, runAntiInterferenceEval, runConflictUpdateEval, runDecisionExtractionEval, runFeishuWorkflowEval, runLlmDecisionExtractionEval, runRecallEval, runRemindEval } from "./eval/runner.js";
import { createAtomFromFact, extractFacts, reconcileFact } from "./extractor/mockExtractor.js";
import { normalizeFeishuChatExport } from "./candidate/feishuChatExport.js";
import { segmentMessages } from "./candidate/segment.js";
import { mergeAdjacentScoredSegments, scoreSegments } from "./candidate/salience.js";
import { buildCandidateWindows } from "./candidate/window.js";
import { extractDecisionBaseline } from "./extractor/ruleDecisionExtractor.js";
import { extractDecisionWithLlm } from "./extractor/llmDecisionExtractor.js";
import { extractionToMemoryAtom } from "./extractor/toMemoryAtom.js";
import { buildDecisionCard, renderDecisionCardFeishuPayload, renderDecisionCardMarkdown } from "./memory/decisionCard.js";
import { formatRecallAnswer } from "./memory/recallFormatter.js";
import { redactWebhookUrl, sendFeishuInteractiveWebhook } from "./feishuWebhook.js";
import { loadEnvValue } from "./llm/config.js";
import { runFeishuWorkflow } from "./workflow/feishuWorkflow.js";
import { buildLarkCliPlan, checkLarkCliStatus, extractTextsFromLarkCliJson, preflightLarkCliPurpose, runLarkCliJson } from "./larkCliAdapter.js";

const program = new Command();

program
  .name("memoryops")
  .description("Kairos: Enterprise long-term collaborative memory engine for Feishu and OpenClaw")
  .version("0.1.0");

async function storeFromOptions(opts: { db?: string; events?: string; store?: string }) {
  return createMemoryStore(opts);
}







const larkCli = program
  .command("lark-cli")
  .description("官方 lark-cli 适配层（当前仅做本地状态检查，不触发授权或数据读取）");

larkCli
  .command("status")
  .option("--check-auth", "同时检查 lark-cli auth status（不发起登录）")
  .option("--profile <profile>", "lark-cli profile 名称")
  .description("检查官方 lark-cli 是否安装及认证状态")
  .action((opts) => {
    console.log(JSON.stringify({ ok: true, command: "lark-cli status", status: checkLarkCliStatus({ checkAuth: !!opts.checkAuth, profile: opts.profile }) }, null, 2));
  });





larkCli
  .command("preflight")
  .requiredOption("--purpose <purpose>", "chat_messages/message_search/doc_fetch/event_consume")
  .option("--profile <profile>", "lark-cli profile 名称")
  .description("检查某类 lark-cli 数据获取所需授权是否满足")
  .action((opts) => {
    console.log(JSON.stringify({ ok: true, command: "lark-cli preflight", preflight: preflightLarkCliPurpose(opts.purpose, { profile: opts.profile }) }, null, 2));
  });


larkCli
  .command("ingest-chat")
  .requiredOption("--chat-id <chatId>", "飞书群聊 chat_id（oc_xxx）")
  .option("--profile <profile>", "lark-cli profile 名称")
  .option("--project <project>", "项目名")
  .option("--page-size <size>", "读取消息数量 1-50", "20")
  .option("--start <time>", "起始时间 ISO 8601")
  .option("--end <time>", "结束时间 ISO 8601")
  .option("--write", "将抽取结果写入 Memory Store")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("调用官方 lark-cli 读取群消息，并进入 Kairos 抽取/入库管道")
  .action(async (opts) => {
    const args = ["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", String(opts.pageSize)];
    if (opts.start) args.push("--start", opts.start);
    if (opts.end) args.push("--end", opts.end);
    if (opts.profile) args.push("--profile", opts.profile);
    const raw = runLarkCliJson(args);
    const texts = extractTextsFromLarkCliJson(raw);
    const store = opts.write ? await storeFromOptions(opts) : undefined;
    const results = [];
    for (const item of texts) {
      const window = {
        id: item.id,
        segment_id: item.id,
        topic_hint: "lark-cli-chat",
        salience_score: 0.8,
        salience_signals: [],
        candidate_eligible: true,
        denoised_text: item.text,
        evidence_message_ids: [item.id],
        dropped_message_ids: [],
        estimated_tokens: Math.ceil(item.text.length / 2),
      };
      const extraction = extractDecisionBaseline(window);
      const atom = extractionToMemoryAtom(extraction, window, opts.project);
      const saved = opts.write && atom ? store!.upsert(atom) : undefined;
      results.push({ source: item, extraction, atom, saved });
    }
    console.log(JSON.stringify({ ok: true, command: "lark-cli ingest-chat", chat_id: opts.chatId, total: results.length, saved_total: results.filter((r) => r.saved).length, results }, null, 2));
  });

larkCli
  .command("ingest-file")
  .requiredOption("--file <path>", "lark-cli --format json 输出文件")
  .option("--project <project>", "项目名")
  .option("--write", "将抽取结果写入 Memory Store")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("离线读取 lark-cli JSON 输出，抽取文本并进入 Kairos 决策抽取管道")
  .action(async (opts) => {
    const raw = JSON.parse(readFileSync(opts.file, "utf8"));
    const texts = extractTextsFromLarkCliJson(raw);
    const store = opts.write ? await storeFromOptions(opts) : undefined;
    const results = [];
    for (const item of texts) {
      const window = {
        id: item.id,
        segment_id: item.id,
        topic_hint: "lark-cli",
        salience_score: 0.8,
        salience_signals: [],
        candidate_eligible: true,
        denoised_text: item.text,
        evidence_message_ids: [item.id],
        dropped_message_ids: [],
        estimated_tokens: Math.ceil(item.text.length / 2),
      };
      const extraction = extractDecisionBaseline(window);
      const atom = extractionToMemoryAtom(extraction, window, opts.project);
      const saved = opts.write && atom ? store!.upsert(atom) : undefined;
      results.push({ source: item, extraction, atom, saved });
    }
    console.log(JSON.stringify({ ok: true, command: "lark-cli ingest-file", total: results.length, results }, null, 2));
  });


larkCli
  .command("plan")
  .requiredOption("--purpose <purpose>", "chat_messages/message_search/doc_fetch/event_consume")
  .option("--chat-id <chatId>", "飞书 chat_id")
  .option("--query <query>", "搜索关键词")
  .option("--doc-url <url>", "飞书文档 URL")
  .option("--event-key <key>", "lark-cli event key")
  .option("--since <time>", "起始时间")
  .option("--until <time>", "结束时间")
  .option("--profile <profile>", "lark-cli profile 名称")
  .description("生成 lark-cli 数据获取命令计划（只输出，不执行）")
  .action((opts) => {
    console.log(JSON.stringify({ ok: true, command: "lark-cli plan", plan: buildLarkCliPlan({ purpose: opts.purpose, chatId: opts.chatId, query: opts.query, docUrl: opts.docUrl, eventKey: opts.eventKey, since: opts.since, until: opts.until, profile: opts.profile }) }, null, 2));
  });

program
  .command("extract-decision")
  .description("从文本或候选窗口中抽取结构化决策/规则/风险/工作流（baseline）")
  .option("--text <text>", "直接输入 denoised_text")
  .option("--file <path>", "从文件读取 denoised_text")
  .option("--project <project>", "项目名")
  .option("--write", "将抽取结果写入 Memory Store")
  .option("--llm", "使用 LLMDecisionExtractor；未指定时使用规则 baseline")
  .option("--fallback", "LLM 调用失败时回退到规则 baseline")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (opts) => {
    if (!opts.text && !opts.file) throw new Error("请提供 --text 或 --file");
    const text = opts.text ?? readFileSync(opts.file, "utf8");
    const window = {
      id: "win_cli",
      segment_id: "seg_cli",
      topic_hint: "manual",
      salience_score: 0.8,
      salience_signals: [],
      candidate_eligible: true,
      denoised_text: text,
      evidence_message_ids: ["manual_input"],
      dropped_message_ids: [],
      estimated_tokens: Math.ceil(text.length / 2),
    };
    const result = opts.llm
      ? await extractDecisionWithLlm(window, { fallback: !!opts.fallback })
      : extractDecisionBaseline(window);
    const atom = extractionToMemoryAtom(result, window, opts.project);
    const saved = opts.write && atom ? (await storeFromOptions(opts)).upsert(atom) : undefined;
    console.log(JSON.stringify({ ok: true, command: "extract-decision", result, atom, saved }, null, 2));
  });

program
  .command("segment-chat-export")
  .description("将飞书会话导出 Markdown 标准化并切分为 topic-coherent segments")
  .requiredOption("--file <path>", "Markdown 文件路径")
  .option("--doc-token <token>", "飞书文档 token")
  .option("--chat-id <chatId>", "原始会话 ID")
  .option("--max-gap-minutes <minutes>", "切分时间间隔", "15")
  .action(async (opts) => {
    const markdown = readFileSync(opts.file, "utf8");
    const messages = normalizeFeishuChatExport(markdown, {
      docToken: opts.docToken,
      chatId: opts.chatId,
    });
    const initialSegments = segmentMessages(messages, {
      maxGapMs: Number(opts.maxGapMinutes) * 60 * 1000,
    });
    const segments = mergeAdjacentScoredSegments(scoreSegments(initialSegments));
    const windows = buildCandidateWindows(segments);
    console.log(JSON.stringify({
      ok: true,
      command: "segment-chat-export",
      message_total: messages.length,
      initial_segment_total: initialSegments.length,
      segment_total: segments.length,
      candidate_window_total: windows.filter((window) => window.candidate_eligible).length,
      segments: segments.map((segment) => ({
        id: segment.id,
        topic_hint: segment.topic_hint,
        message_count: segment.messages.length,
        boundary_reasons: segment.boundary_reasons,
        salience_score: segment.salience_score,
        salience_signals: segment.salience_signals,
        domain_hint: segment.domain_hint,
        start_time: segment.start_time,
        end_time: segment.end_time,
        preview: segment.messages.map((message) => `${message.sender}: ${message.text}`).slice(0, 8),
      })),
      windows: windows.map((window) => ({
        id: window.id,
        segment_id: window.segment_id,
        topic_hint: window.topic_hint,
        candidate_eligible: window.candidate_eligible,
        salience_score: window.salience_score,
        salience_signals: window.salience_signals,
        evidence_message_ids: window.evidence_message_ids,
        dropped_message_ids: window.dropped_message_ids,
        estimated_tokens: window.estimated_tokens,
        denoised_text: window.denoised_text,
      })),
    }, null, 2));
  });

program
  .command("normalize-chat-export")
  .description("将飞书会话导出云文档的 Markdown 标准化为逐条 NormalizedMessage")
  .requiredOption("--file <path>", "Markdown 文件路径")
  .option("--doc-token <token>", "飞书文档 token")
  .option("--chat-id <chatId>", "原始会话 ID")
  .option("--limit <limit>", "输出前 N 条", "20")
  .action(async (opts) => {
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
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (opts) => {
    if (!opts.text && !opts.file) {
      throw new Error("请提供 --text 或 --file");
    }
    const inputs: string[] = [];
    if (opts.text) inputs.push(opts.text);
    if (opts.file) {
      const fileText = readFileSync(opts.file, "utf8");
      inputs.push(...fileText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }

    const store = await storeFromOptions(opts);
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
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (opts) => {
    const atom = createManualMemory({
      text: opts.text,
      project: opts.project,
      type: opts.type,
      scope: opts.scope,
      subject: opts.subject,
      tags: opts.tag ?? [],
    });
    const saved = (await storeFromOptions(opts)).upsert(atom);
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
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (query, opts) => {
    const results = (await storeFromOptions(opts)).search(query, {
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
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("从记忆中召回答案（当前为检索式 MVP）")
  .action(async (query, opts) => {
    const results = (await storeFromOptions(opts)).search(query, {
      project: opts.project,
      limit: 5,
    });
    const answer = formatRecallAnswer(query, results);
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
  .command("decision-card")
  .argument("<atomId>")
  .description("输出历史决策卡片文本（Markdown），用于 CLI/飞书卡片前的稳定展示层")
  .option("--json", "输出结构化 JSON，而不是 Markdown")
  .option("--feishu-json", "输出飞书 interactive card payload JSON（仅生成，不发送）")
  .option("--send-feishu-webhook", "通过飞书机器人 webhook 发送卡片（外部动作，必须显式指定）")
  .option("--feishu-webhook <url>", "飞书机器人 webhook；也可用 KAIROS_FEISHU_WEBHOOK_URL")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (atomId, opts) => {
    const atom = (await storeFromOptions(opts)).get(atomId);
    if (!atom) {
      console.log(JSON.stringify({ ok: false, command: "decision-card", error: `记忆不存在：${atomId}` }, null, 2));
      process.exitCode = 1;
      return;
    }
    const card = buildDecisionCard(atom);
    const feishuCard = renderDecisionCardFeishuPayload(card);
    if (opts.sendFeishuWebhook) {
      const webhookUrl = opts.feishuWebhook ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL");
      if (!webhookUrl) throw new Error("缺少飞书 webhook：请传 --feishu-webhook 或设置 KAIROS_FEISHU_WEBHOOK_URL");
      const result = await sendFeishuInteractiveWebhook(webhookUrl, feishuCard);
      console.log(JSON.stringify({ ok: result.ok, command: "decision-card", sent: result, webhook: redactWebhookUrl(webhookUrl), memory_id: atom.id }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (opts.feishuJson) {
      console.log(JSON.stringify({ ok: true, command: "decision-card", card: feishuCard }, null, 2));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, command: "decision-card", card }, null, 2));
      return;
    }
    console.log(renderDecisionCardMarkdown(card));
  });


program
  .command("feishu-workflow")
  .description("处理一条飞书消息文本，判断是否需要召回/推送历史记忆卡片")
  .option("--text <text>", "飞书消息文本")
  .option("--file <path>", "从文件读取消息文本")
  .option("--project <project>", "项目名")
  .option("--send-feishu-webhook", "当建议推送卡片时，通过飞书机器人 webhook 发送")
  .option("--feishu-webhook <url>", "飞书机器人 webhook；也可用 KAIROS_FEISHU_WEBHOOK_URL")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (opts) => {
    if (!opts.text && !opts.file) throw new Error("请提供 --text 或 --file");
    const text = opts.text ?? readFileSync(opts.file, "utf8");
    const result = runFeishuWorkflow(await storeFromOptions(opts), { text, project: opts.project });
    if (opts.sendFeishuWebhook && result.action === "push_decision_card" && result.card) {
      const webhookUrl = opts.feishuWebhook ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL");
      if (!webhookUrl) throw new Error("缺少飞书 webhook：请传 --feishu-webhook 或设置 KAIROS_FEISHU_WEBHOOK_URL");
      const sent = await sendFeishuInteractiveWebhook(webhookUrl, result.card);
      console.log(JSON.stringify({ ...result, sent, webhook: redactWebhookUrl(webhookUrl) }, null, 2));
      if (!sent.ok) process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list")
  .description("列出记忆")
  .option("--project <project>", "项目名")
  .option("--type <type>", "记忆类型")
  .option("--scope <scope>", "作用域")
  .option("--include-history", "包含历史记忆")
  .option("--limit <limit>", "返回数量", "20")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (opts) => {
    const results = (await storeFromOptions(opts)).list({
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
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .action(async (atomId, opts) => {
    const atom = (await storeFromOptions(opts)).get(atomId);
    console.log(JSON.stringify({ ok: !!atom, command: "history", atom }, null, 2));
  });

const remind = program
  .command("remind")
  .description("管理 review_at 到期提醒（本地 MVP，不做推送）");

remind
  .command("list", { isDefault: true })
  .option("--now <time>", "mock current time, ISO 8601")
  .option("--project <project>", "项目名")
  .option("--type <type>", "记忆类型，默认不过滤")
  .option("--limit <limit>", "返回数量", "20")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("列出 review_at 已到期的记忆提醒")
  .action(async (opts) => {
    const now = opts.now ?? new Date().toISOString();
    const reminders = (await storeFromOptions(opts)).dueReminders({
      now,
      project: opts.project,
      type: opts.type,
      limit: Number(opts.limit),
    });
    console.log(JSON.stringify({
      ok: true,
      command: "remind",
      now,
      total: reminders.length,
      reminders: reminders.map((item) => ({
        id: item.id,
        type: item.type,
        project: item.project,
        subject: item.subject,
        content: item.content,
        review_at: item.review_at,
        importance: item.importance,
        source: item.source,
      })),
    }, null, 2));
  });

remind
  .command("ack")
  .argument("<atomId>")
  .option("--now <time>", "mock current time, ISO 8601")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("标记一条提醒已处理，并清除 review_at")
  .action(async (atomId, opts) => {
    const atom = (await storeFromOptions(opts)).ackReminder(atomId, { now: opts.now });
    console.log(JSON.stringify({ ok: true, command: "remind ack", atom }, null, 2));
  });

remind
  .command("snooze")
  .argument("<atomId>")
  .requiredOption("--until <time>", "新的 review_at，ISO 8601")
  .option("--now <time>", "mock current time, ISO 8601")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("稍后提醒：把 review_at 改到指定时间")
  .action(async (atomId, opts) => {
    const atom = (await storeFromOptions(opts)).snoozeReminder(atomId, opts.until, { now: opts.now });
    console.log(JSON.stringify({ ok: true, command: "remind snooze", atom }, null, 2));
  });

program
  .command("eval")
  .option("--smoke", "run smoke benchmark")
  .option("--core", "run core benchmark: decision extraction + conflict update + recall")
  .option("--suite <suite>", "run a specific suite: decision-extraction | conflict-update | recall | anti-interference | remind | feishu-workflow | llm-decision-extraction")
  .description("Run benchmarks")
  .action(async (opts) => {
    if (opts.smoke) {
      const cases = loadSmokeCases();
      console.log(JSON.stringify({ ok: true, command: "eval", smoke: true, ...summarizeSmokeCases(cases) }, null, 2));
      return;
    }
    if (opts.core) {
      const results = runAllCoreEvals();
      console.log(JSON.stringify({ ok: true, command: "eval", core: true, results }, null, 2));
      return;
    }
    if (opts.suite) {
      const result = opts.suite === "decision-extraction"
        ? runDecisionExtractionEval()
        : opts.suite === "conflict-update"
          ? runConflictUpdateEval()
          : opts.suite === "recall"
            ? runRecallEval()
            : opts.suite === "anti-interference"
              ? runAntiInterferenceEval()
              : opts.suite === "remind"
                ? runRemindEval()
                : opts.suite === "feishu-workflow"
                  ? runFeishuWorkflowEval()
                  : opts.suite === "llm-decision-extraction"
                    ? await runLlmDecisionExtractionEval()
                    : undefined;
      if (!result) throw new Error(`未知 suite: ${opts.suite}`);
      console.log(JSON.stringify({ ok: true, command: "eval", result }, null, 2));
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
