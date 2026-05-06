#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryAtomSchema } from "./memory/schema.js";
import { createManualMemory } from "./memory/factory.js";
import { createMemoryStore } from "./memory/storeFactory.js";
import { loadSmokeCases, summarizeSmokeCases } from "./eval/smoke.js";
import { runAllCoreEvals, runAntiInterferenceEval, runConflictUpdateEval, runDecisionExtractionEval, runFeishuWorkflowEval, runLlmDecisionExtractionEval, runRecallEval, runRemindEval, runThreadLinkingEval } from "./eval/runner.js";
import { createAtomFromFact, extractFacts, reconcileFact } from "./extractor/mockExtractor.js";
import { normalizeFeishuChatExport } from "./candidate/feishuChatExport.js";
import { segmentMessages } from "./candidate/segment.js";
import { mergeAdjacentScoredSegments, scoreSegments } from "./candidate/salience.js";
import { buildCandidateWindows, type CandidateWindow } from "./candidate/window.js";
import { extractDecisionBaseline } from "./extractor/ruleDecisionExtractor.js";
import { extractDecisionWithLlm } from "./extractor/llmDecisionExtractor.js";
import { extractionToMemoryAtom } from "./extractor/toMemoryAtom.js";
import { buildDecisionCard, renderDecisionCardFeishuPayload, renderDecisionCardMarkdown } from "./memory/decisionCard.js";
import { applyDecisionCardFeedback } from "./memory/cardFeedback.js";
import { reconcileAndApplyMemoryAtom } from "./memory/reconcile.js";
import { InductionQueue } from "./induction/queue.js";
import { RefineQueue } from "./refine/queue.js";
import { applyRefinePatch, triageRefineJob } from "./refine/processor.js";
import { formatRecallAnswer } from "./memory/recallFormatter.js";
import { redactWebhookUrl, sendFeishuInteractiveWebhook } from "./feishuWebhook.js";
import { loadEnvValue } from "./llm/config.js";
import { runFeishuWorkflow } from "./workflow/feishuWorkflow.js";
import { ActivationThrottle } from "./workflow/activationThrottle.js";
import { buildEngineDashboardData, serveEngineDashboard, writeEngineDashboardHtml } from "./visualization/dashboard.js";
import { buildLarkCliPlan, checkLarkCliStatus, extractTextsFromLarkCliJson, preflightLarkCliPurpose, runLarkCliJson, runLarkCliText, toNormalizedMessages } from "./larkCliAdapter.js";
import { runLarkRuntime } from "./larkRuntime/worker.js";
import { threadMessages, type ConversationThread } from "./candidate/thread.js";
import { linkThreadsWithLlm } from "./candidate/llmThreadLinker.js";
import { buildCandidateWindowFromThread } from "./candidate/window.js";

const program = new Command();

program
  .name("memoryops")
  .description("Kairos: Enterprise long-term collaborative memory engine for Feishu and OpenClaw")
  .version("0.1.0");

async function storeFromOptions(opts: { db?: string; events?: string; store?: string }) {
  return createMemoryStore(opts);
}

function refineWindowWithLlmThread(window: CandidateWindow, messages: ReturnType<typeof toNormalizedMessages>, llmThreads: Array<{ id: string; message_ids: string[]; topic_hint?: string; confidence: number }>): CandidateWindow {
  const evidenceSet = new Set(window.evidence_message_ids);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const best = llmThreads
    .map((thread) => ({ thread, overlap: thread.message_ids.filter((id) => evidenceSet.has(id)).length }))
    .sort((a, b) => b.overlap - a.overlap || b.thread.confidence - a.thread.confidence)[0];
  if (!best || best.overlap === 0) return window;
  const selected = best.thread.message_ids.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m).sort((a, b) => a.timestamp - b.timestamp);
  if (!selected.length) return window;
  return {
    ...window,
    denoised_text: selected.map((m) => `${m.sender}：${m.text}`).join("\n"),
    evidence_message_ids: selected.map((m) => m.id),
    topic_hint: best.thread.topic_hint ?? window.topic_hint,
    salience_signals: [...new Set([...window.salience_signals, "llm_thread_linked_context"])],
    dropped_message_ids: messages.filter((m) => !best.thread.message_ids.includes(m.id)).map((m) => m.id),
  };
}

function buildThreadLinkingSilverSample(input: {
  id: string;
  messages: ReturnType<typeof toNormalizedMessages>;
  threads: Array<{ id: string; message_ids: string[]; topic_hint?: string; confidence?: number }>;
  labelSource: string;
}) {
  const idMap = new Map(input.messages.map((m, i) => [m.id, `m${i + 1}`]));
  const senderMap = new Map<string, string>();
  const senderAlias = (sender: string) => {
    if (!senderMap.has(sender)) senderMap.set(sender, `user_${senderMap.size + 1}`);
    return senderMap.get(sender)!;
  };
  return {
    id: input.id,
    source: { platform: "feishu", redacted: true, label_source: input.labelSource },
    messages: input.messages.map((m) => ({
      id: idMap.get(m.id),
      sender: senderAlias(m.sender),
      timestamp: m.timestamp,
      text: redactText(m.text),
    })),
    expected_threads: input.threads
      .map((t) => t.message_ids.map((id) => idMap.get(id)).filter(Boolean))
      .filter((ids) => ids.length > 0),
    label_metadata: input.threads.map((t) => ({
      id: t.id,
      topic_hint: t.topic_hint,
      confidence: t.confidence,
      message_ids: t.message_ids.map((id) => idMap.get(id)).filter(Boolean),
    })),
  };
}

function redactText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL>")
    .replace(/https?:\/\/[^\s]+/g, "<URL>")
    .replace(/\b(?:\d{3,4}[- ]?)?\d{7,11}\b/g, "<PHONE>")
    .replace(/(api[_-]?key|token|secret|password|AKIA)[=:：]?\s*[^\s，。]+/gi, "$1=<REDACTED>");
}

function writeJsonl(path: string, items: unknown[], append: boolean) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  writeFileSync(path, body, { encoding: "utf8", flag: append ? "a" : "w" });
}

function saveEvalOutput(path: string | undefined, output: unknown) {
  if (!path) return;
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2), "utf8");
}

function upsertEnvFile(path: string, values: Record<string, string>) {
  const existing = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const keys = new Set(Object.keys(values));
  const next = existing.filter((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    return !key || !keys.has(key);
  }).filter((line, idx, arr) => line.trim() || idx < arr.length - 1);
  for (const [key, value] of Object.entries(values)) {
    next.push(`${key}=${quoteEnvValue(value)}`);
  }
  writeFileSync(path, `${next.join("\n").trim()}\n`, "utf8");
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function conversationThreadsFromLlm(messages: ReturnType<typeof toNormalizedMessages>, llmThreads: Array<{ id: string; message_ids: string[]; topic_hint?: string; confidence: number }>): ConversationThread[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return llmThreads.map((thread) => {
    const threadMessages = thread.message_ids.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m).sort((a, b) => a.timestamp - b.timestamp);
    return {
      id: thread.id,
      messages: threadMessages,
      topic_hint: thread.topic_hint,
      participants: [...new Set(threadMessages.map((m) => m.sender))],
      start_time: threadMessages[0]?.timestamp ?? 0,
      end_time: threadMessages[threadMessages.length - 1]?.timestamp ?? 0,
      confidence: thread.confidence,
    };
  }).filter((thread) => thread.messages.length > 0);
}

function summarizeActivationActions(actions: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) counts[action] = (counts[action] ?? 0) + 1;
  return counts;
}








program
  .command("doctor")
  .option("--profile <profile>", "lark-cli profile 名称", "kairos-alt")
  .option("--chat-id <chatId>", "可选：真实飞书群聊 chat_id，用于验证读取")
  .option("--project <project>", "项目名", "kairos")
  .option("--trigger-text <text>", "可选：端到端触发文本", "要不我们还是用 PostgreSQL？")
  .option("--e2e", "提供 --chat-id 时同时跑真实 e2e-chat")
  .option("--pretty", "输出人类友好的诊断摘要")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("Kairos/OpenClaw/lark-cli 安装配置诊断；用于 GitHub 链接自动安装后的验收")
  .action(async (opts) => {
    const checks = [] as Array<{ name: string; ok: boolean; detail?: unknown; next?: string }>;
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "node>=22", ok: nodeMajor >= 22, detail: process.version, next: nodeMajor >= 22 ? undefined : "安装 Node.js 22+" });
    checks.push({ name: "openclaw.setup.json", ok: existsSync("openclaw.setup.json"), next: "确认当前目录是 Kairos 仓库根目录" });
    const larkStatus = checkLarkCliStatus({ checkAuth: true, profile: opts.profile });
    checks.push({ name: "lark-cli installed", ok: larkStatus.installed, detail: larkStatus.version, next: "npm install -g @larksuite/cli" });
    checks.push({ name: `lark-cli profile ${opts.profile}`, ok: !!larkStatus.auth_ok, detail: larkStatus.auth_ok ? "authorized" : larkStatus.auth_summary || larkStatus.error, next: `lark-cli auth login --recommend --profile ${opts.profile}  # 按官方引导保持进程等待，不要反复 config init --new` });
    const chatPreflight = preflightLarkCliPurpose("chat_messages", { profile: opts.profile });
    checks.push({ name: "chat_messages scope", ok: chatPreflight.missing_scopes.length === 0, detail: { required: chatPreflight.required_scopes, missing: chatPreflight.missing_scopes }, next: chatPreflight.recommended_command?.join(" ") });
    const searchPreflight = preflightLarkCliPurpose("message_search", { profile: opts.profile });
    checks.push({ name: "message_search scope optional", ok: searchPreflight.missing_scopes.length === 0, detail: { optional: true, missing: searchPreflight.missing_scopes }, next: "可忽略；主流程按 chat_id 读取群消息" });
    let chatRead: unknown = undefined;
    let e2e: unknown = undefined;
    if (opts.chatId) {
      try {
        const raw = runLarkCliJson(["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", "5", "--profile", opts.profile]);
        const texts = extractTextsFromLarkCliJson(raw);
        chatRead = { ok: true, text_count: texts.length };
        checks.push({ name: "read chat messages", ok: true, detail: chatRead });
      } catch (error) {
        chatRead = { ok: false, error: String(error) };
        checks.push({ name: "read chat messages", ok: false, detail: chatRead, next: "确认 chat_id、profile 权限、用户是否在群内" });
      }
      if (opts.e2e) {
        try {
          const store = await storeFromOptions(opts);
          const raw = runLarkCliJson(["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", "20", "--profile", opts.profile]);
          const texts = extractTextsFromLarkCliJson(raw);
          let savedTotal = 0;
          for (const item of texts) {
            const window = { id: item.id, segment_id: item.id, topic_hint: "doctor-e2e", salience_score: 0.8, salience_signals: [], candidate_eligible: true, denoised_text: item.text, evidence_message_ids: [item.id], dropped_message_ids: [], estimated_tokens: Math.ceil(item.text.length / 2) };
            const extraction = extractDecisionBaseline(window);
            const atom = extractionToMemoryAtom(extraction, window, opts.project);
            if (atom) { store.upsert(atom); savedTotal += 1; }
          }
          const workflow = runFeishuWorkflow(store, { text: opts.triggerText, project: opts.project });
          e2e = { ok: workflow.action === "push_decision_card", read_total: texts.length, saved_total: savedTotal, workflow_action: workflow.action, memory_id: workflow.memory_id };
          checks.push({ name: "e2e chat -> memory -> workflow", ok: workflow.action === "push_decision_card", detail: e2e, next: "群里需存在可抽取的历史决策，并用相关 trigger-text 验证" });
        } catch (error) {
          e2e = { ok: false, error: String(error) };
          checks.push({ name: "e2e chat -> memory -> workflow", ok: false, detail: e2e, next: "先跑 memoryops lark-cli e2e-chat 定位详情" });
        }
      }
    }
    const requiredOk = checks.filter((c) => !c.name.includes("optional")).every((c) => c.ok);
    const report = { ok: requiredOk, command: "doctor", profile: opts.profile, chat_id: opts.chatId, checks };
    if (opts.pretty) console.log(renderDoctorPretty(report));
    else console.log(JSON.stringify(report, null, 2));
    if (!requiredOk) process.exitCode = 1;
  });

program
  .command("setup-wizard")
  .option("--profile <profile>", "lark-cli profile 名称", "kairos-alt")
  .option("--chat-id <chatId>", "可选：目标群 chat_id，用于生成最终验收命令")
  .description("输出 Kairos + lark-cli 安装配置向导的下一步动作；阻塞授权步骤由 Agent/用户按提示执行")
  .action((opts) => {
    const larkStatus = checkLarkCliStatus({ checkAuth: true, profile: opts.profile });
    const chatPreflight = preflightLarkCliPurpose("chat_messages", { profile: opts.profile });
    const steps = [] as Array<{ id: string; status: "done" | "todo"; command?: string; userAction?: string; note?: string }>;
    steps.push({ id: "build", status: existsSync("dist/cli.js") ? "done" : "todo", command: "npm install && npm run build" });
    steps.push({ id: "install-openclaw-plugin", status: existsSync("hooks/kairos-feishu-ingress/handler.js") && existsSync("openclaw.setup.json") ? "done" : "todo", command: "openclaw plugins install . && openclaw gateway restart", note: "仓库已包含插件元数据；如目标 OpenClaw 未安装过仍需执行该命令" });
    steps.push({ id: "install-lark-cli", status: larkStatus.installed ? "done" : "todo", command: "npm install -g @larksuite/cli" });
    steps.push({ id: "authorize-profile", status: larkStatus.auth_ok ? "done" : "todo", command: `lark-cli auth login --recommend --profile ${opts.profile}`, userAction: "按 lark-cli 官方引导打开链接完成授权；保持命令运行，不要反复 config init --new 创建新应用" });
    steps.push({ id: "preflight", status: chatPreflight.missing_scopes.length === 0 ? "done" : "todo", command: `memoryops doctor --profile ${opts.profile} --pretty`, note: chatPreflight.missing_scopes.length ? `缺少：${chatPreflight.missing_scopes.join(", ")}` : "chat_messages ready" });
    steps.push({ id: "get-chat-id", status: opts.chatId ? "done" : "todo", command: `lark-cli im +chat-search --query <群名关键词> --format json --profile ${opts.profile}`, userAction: "或让用户直接提供 oc_xxx chat_id" });
    steps.push({ id: "final-e2e", status: "todo", command: opts.chatId ? `memoryops doctor --profile ${opts.profile} --chat-id ${opts.chatId} --e2e --pretty` : `memoryops doctor --profile ${opts.profile} --chat-id <oc_xxx> --e2e --pretty` });
    const done = steps.filter((s) => s.status === "done").length;
    const next = steps.find((s) => s.status === "todo");
    console.log(JSON.stringify({ ok: !next, command: "setup-wizard", profile: opts.profile, progress: `${done}/${steps.length}`, next, steps }, null, 2));
  });

function renderDoctorPretty(report: { ok: boolean; profile: string; chat_id?: string; checks: Array<{ name: string; ok: boolean; detail?: unknown; next?: string }> }): string {
  const lines = [
    `Kairos doctor (${report.profile})`,
    `Status: ${report.ok ? "READY" : "NEEDS_ACTION"}`,
    report.chat_id ? `Chat: ${report.chat_id}` : undefined,
    "",
  ].filter(Boolean) as string[];
  for (const check of report.checks) {
    const optional = check.name.includes("optional");
    const icon = check.ok ? "✅" : optional ? "⚠️" : "❌";
    lines.push(`${icon} ${check.name}`);
    if (!check.ok && check.next) lines.push(`   next: ${check.next}`);
    if (check.detail && (check.name.includes("e2e") || check.name.includes("read chat"))) lines.push(`   detail: ${JSON.stringify(check.detail)}`);
  }
  lines.push("", report.ok ? "Ready for lark-cli demo." : "Fix required checks above, then rerun doctor.");
  return lines.join("\n");
}

const larkCli = program
  .command("lark-cli")
  .description("官方 lark-cli 适配层（当前仅做本地状态检查，不触发授权或数据读取）");

larkCli
  .command("runtime-setup")
  .option("--profile <profile>", "lark-cli profile", "kairos-alt")
  .option("--chat-id <chatId>", "要监听的飞书群 chat_id；也可读取 KAIROS_CHAT_ID")
  .option("--feishu-webhook <url>", "飞书机器人 webhook；也可读取 KAIROS_FEISHU_WEBHOOK_URL")
  .option("--write-env", "把 profile/chat_id/webhook 写入 .env")
  .option("--test-read", "测试读取目标群最近消息")
  .option("--test-webhook", "发送一条测试卡片到 webhook 绑定群")
  .description("lark-runtime 接入向导：检查 lark-cli/profile/chat_id/webhook，并可写入 .env")
  .action(async (opts) => {
    const profile = nonEmpty(opts.profile) ?? loadEnvValue("KAIROS_LARK_PROFILE") ?? "kairos-alt";
    const chatId = nonEmpty(opts.chatId) ?? loadEnvValue("KAIROS_CHAT_ID");
    const webhook = nonEmpty(opts.feishuWebhook) ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL");
    const status = checkLarkCliStatus({ checkAuth: true, profile });
    const preflight = preflightLarkCliPurpose("chat_messages", { profile });
    const checks = [] as Array<{ name: string; ok: boolean; detail?: unknown; next?: string }>;
    checks.push({ name: "lark-cli installed", ok: status.installed, detail: status.version, next: "npm install -g @larksuite/cli" });
    checks.push({ name: "lark-cli profile authorized", ok: !!status.auth_ok, detail: status.auth_summary, next: `lark-cli auth login --recommend --profile ${profile}  # 按官方引导保持进程等待，不要反复 config init --new` });
    checks.push({ name: "chat_messages scope", ok: preflight.missing_scopes.length === 0, detail: { missing_scopes: preflight.missing_scopes }, next: preflight.recommended_command?.join(" ") });
    checks.push({ name: "KAIROS_CHAT_ID", ok: !!chatId, detail: chatId, next: `lark-cli im +chat-list --format json --profile ${profile}` });
    checks.push({ name: "KAIROS_FEISHU_WEBHOOK_URL", ok: !!webhook, detail: webhook ? redactWebhookUrl(webhook) : undefined, next: "在目标飞书群添加自定义机器人，复制 webhook" });

    let readResult;
    if (opts.testRead && chatId) {
      try {
        const raw = runLarkCliJson(["im", "+chat-messages-list", "--chat-id", chatId, "--format", "json", "--page-size", "3", "--profile", profile]);
        const messages = toNormalizedMessages(raw, chatId);
        readResult = { ok: true, messages: messages.length, sample: messages.slice(0, 2).map((m) => ({ id: m.id, sender: m.sender, text: m.text.slice(0, 80) })) };
      } catch (error) {
        readResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      checks.push({ name: "read target chat", ok: !!readResult.ok, detail: readResult, next: "确认账号在目标群内且具备消息读取权限" });
    }

    let webhookResult;
    if (opts.testWebhook && webhook) {
      webhookResult = await sendFeishuInteractiveWebhook(webhook, {
        config: { wide_screen_mode: true },
        header: { title: { tag: "plain_text", content: "Kairos 接入测试" }, template: "blue" },
        elements: [{ tag: "markdown", content: "✅ Kairos 已成功连接到这个飞书群。" }],
      });
      checks.push({ name: "send test card", ok: webhookResult.ok, detail: webhookResult, next: "确认 webhook 来自目标飞书群的自定义机器人" });
    }

    if (opts.writeEnv) {
      if (!chatId) throw new Error("--write-env 需要 --chat-id 或 KAIROS_CHAT_ID");
      upsertEnvFile(".env", {
        KAIROS_PROJECT: "kairos",
        KAIROS_LARK_PROFILE: profile,
        KAIROS_CHAT_ID: chatId,
        ...(webhook ? { KAIROS_FEISHU_WEBHOOK_URL: webhook } : {}),
      });
      checks.push({ name: "write .env", ok: true, detail: ".env" });
    }

    const ok = checks.every((c) => c.ok || c.name === "KAIROS_FEISHU_WEBHOOK_URL");
    console.log(JSON.stringify({
      ok,
      command: "lark-cli runtime-setup",
      profile,
      chat_id: chatId,
      webhook: webhook ? redactWebhookUrl(webhook) : undefined,
      checks,
      official_lark_cli_auth_note: "授权请按 lark-cli 官方 auth login 页面完成；不要反复运行 config init --new；授权命令需要保持运行直到成功返回。",
      next: ok ? ["npm run dashboard", "npm run lark-runtime"] : checks.find((c) => !c.ok)?.next,
    }, null, 2));
  });

larkCli
  .command("runtime")
  .option("--chat-id <chatId>", "飞书群聊 chat_id；也可用 KAIROS_CHAT_ID")
  .option("--profile <profile>", "lark-cli profile；也可用 KAIROS_LARK_PROFILE")
  .option("--project <project>", "项目名", "kairos")
  .option("--interval-ms <ms>", "轮询间隔", "10000")
  .option("--page-size <size>", "每轮读取消息数", "20")
  .option("--once", "只跑一轮，便于调试")
  .option("--send-feishu-webhook", "activation 命中时通过飞书机器人 webhook 发卡")
  .option("--feishu-webhook <url>", "飞书机器人 webhook；也可用 KAIROS_FEISHU_WEBHOOK_URL")
  .option("--state <path>", "已处理消息状态文件", "data/lark_runtime_state.json")
  .option("--runtime-log <path>", "runtime JSONL 日志", "runs/lark-runtime.jsonl")
  .option("--induction-queue <path>", "induction queue JSONL 路径", "data/induction_queue.jsonl")
  .option("--activation-throttle <path>", "activation throttle JSONL 路径", "data/activation_throttle.jsonl")
  .option("--cooldown-ms <ms>", "同群同 memory 推卡冷却时间", "900000")
  .option("--llm-thread-link", "后台归纳时使用 LLM thread linking")
  .option("--fallback", "LLM 失败时 fallback 到 baseline", true)
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("lark-cli 产品运行时：轮询群消息、归纳记忆、激活卡片、写 Dashboard 状态")
  .action(async (opts) => {
    await runLarkRuntime({
      chatId: nonEmpty(opts.chatId) ?? loadEnvValue("KAIROS_CHAT_ID") ?? "",
      profile: nonEmpty(opts.profile) ?? loadEnvValue("KAIROS_LARK_PROFILE") ?? "kairos-alt",
      project: opts.project,
      pageSize: Number(opts.pageSize),
      intervalMs: Number(opts.intervalMs),
      once: !!opts.once,
      sendFeishuWebhook: !!opts.sendFeishuWebhook,
      feishuWebhookUrl: nonEmpty(opts.feishuWebhook) ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL"),
      statePath: opts.state,
      runtimeLogPath: opts.runtimeLog,
      inductionQueuePath: opts.inductionQueue,
      activationThrottlePath: opts.activationThrottle,
      cooldownMs: Number(opts.cooldownMs),
      llmThreadLink: !!opts.llmThreadLink,
      fallback: !!opts.fallback,
      store: await storeFromOptions(opts),
    });
  });

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
  .command("e2e-chat")
  .requiredOption("--chat-id <chatId>", "飞书群聊 chat_id（oc_xxx）")
  .option("--profile <profile>", "lark-cli profile 名称")
  .option("--project <project>", "项目名", "kairos")
  .option("--trigger-text <text>", "用于模拟新消息触发召回", "要不我们还是用 PostgreSQL？")
  .option("--page-size <size>", "读取消息数量 1-50", "20")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("端到端：读取真实飞书群消息 → Kairos 入库 → 用触发文本生成工作流决策")
  .action(async (opts) => {
    const args = ["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", String(opts.pageSize)];
    if (opts.profile) args.push("--profile", opts.profile);
    const raw = runLarkCliJson(args);
    const texts = extractTextsFromLarkCliJson(raw);
    const store = await storeFromOptions(opts);
    const ingested = [];
    for (const item of texts) {
      const window = {
        id: item.id,
        segment_id: item.id,
        topic_hint: "lark-cli-e2e-chat",
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
      const saved = atom ? store.upsert(atom) : undefined;
      ingested.push({ source: item, extraction, saved });
    }
    const workflow = runFeishuWorkflow(store, { text: opts.triggerText, project: opts.project });
    console.log(JSON.stringify({
      ok: true,
      command: "lark-cli e2e-chat",
      chat_id: opts.chatId,
      profile: opts.profile,
      read_total: texts.length,
      saved_total: ingested.filter((item) => item.saved).length,
      trigger_text: opts.triggerText,
      workflow,
      ingested,
    }, null, 2));
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
  .option("--thread-gap <ms>", "会话解缠时间间隔阈值(ms)", "300000")
  .option("--llm-thread-link", "使用 LLM 进行慢速会话解缠；失败时降级到启发式")
  .option("--enqueue-induction", "只将候选窗口加入 LLM slow induction 队列，不实时抽取")
  .option("--induction-queue <path>", "induction queue JSONL 路径", "data/induction_queue.jsonl")
  .description("调用官方 lark-cli 读取群消息，线程化→窗口化→抽取→入库")
  .action(async (opts) => {
    const args = ["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", String(opts.pageSize)];
    if (opts.start) args.push("--start", opts.start);
    if (opts.end) args.push("--end", opts.end);
    if (opts.profile) args.push("--profile", opts.profile);

    // 1. 读取原始 JSON
    const raw = runLarkCliJson(args);

    // 2. 转换为 NormalizedMessage（保留完整元数据）
    const messages = toNormalizedMessages(raw, opts.chatId);

    // 3. 会话解缠：消息 → 线程
    const llmThreadLink = opts.llmThreadLink ? await linkThreadsWithLlm(messages) : undefined;
    const threads = llmThreadLink && !llmThreadLink.degraded
      ? conversationThreadsFromLlm(messages, llmThreadLink.threads)
      : threadMessages(messages, { max_gap_ms: Number(opts.threadGap) });

    // 4. 每个线程构造 CandidateWindow
    const windows = threads.map((t) => buildCandidateWindowFromThread(t));

    // 5. 可选：只入 slow induction 队列，不实时抽取
    if (opts.enqueueInduction) {
      const queue = new InductionQueue(opts.inductionQueue);
      const jobs = windows
        .filter((win) => win.has_resolution_cue || win.salience_score >= 5)
        .map((win) => queue.enqueue({
          id: win.id,
          segment_id: win.thread_id ?? win.id,
          topic_hint: win.topic_hint ?? "",
          salience_score: win.salience_score,
          salience_signals: win.salience_reasons,
          candidate_eligible: true,
          denoised_text: win.denoised_text,
          evidence_message_ids: win.evidence_message_ids,
          dropped_message_ids: win.dropped_message_ids,
          estimated_tokens: win.estimated_tokens,
          source_channel: "feishu",
          source_type: "feishu_message",
        }, { project: opts.project, contextMessages: messages }));
      console.log(JSON.stringify({
        ok: true,
        command: "lark-cli ingest-chat",
        mode: "enqueue-induction",
        chat_id: opts.chatId,
        messages: messages.length,
        threads: threads.length,
        thread_linker: llmThreadLink ? { degraded: llmThreadLink.degraded, error: llmThreadLink.error, prompt_version: llmThreadLink.prompt_version } : { degraded: false, method: "heuristic" },
        windows: windows.length,
        enqueued: jobs.length,
        jobs,
      }, null, 2));
      return;
    }

    // 6. 从窗口抽取决策
    const store = opts.write ? await storeFromOptions(opts) : undefined;
    const results = [];
    for (const win of windows) {
      // 只处理有 resolution 信号或足够 salience 的窗口
      if (!win.has_resolution_cue && win.salience_score < 5) {
        results.push({ window: win.id, skipped: true, reason: "no_resolution_cue_and_low_salience" });
        continue;
      }
      const extraction = extractDecisionBaseline({
        id: win.id,
        segment_id: win.thread_id ?? win.id,
        topic_hint: win.topic_hint ?? "",
        salience_score: win.salience_score,
        salience_signals: win.salience_reasons,
        candidate_eligible: true,
        denoised_text: win.denoised_text,
        evidence_message_ids: win.evidence_message_ids,
        dropped_message_ids: win.dropped_message_ids,
        estimated_tokens: win.estimated_tokens,
        source_channel: "feishu",
        source_type: "feishu_message",
      });
      const atom = extractionToMemoryAtom(extraction, {
        id: win.id,
        segment_id: win.thread_id ?? win.id,
        topic_hint: win.topic_hint ?? "",
        salience_score: win.salience_score,
        salience_signals: win.salience_reasons,
        candidate_eligible: true,
        denoised_text: win.denoised_text,
        evidence_message_ids: win.evidence_message_ids,
        dropped_message_ids: win.dropped_message_ids,
        estimated_tokens: win.estimated_tokens,
        source_channel: "feishu",
        source_type: "feishu_message",
      }, opts.project);
      const reconcile = opts.write && atom ? reconcileAndApplyMemoryAtom(store!, atom) : undefined;
      const saved = reconcile?.action === "ADD" || reconcile?.action === "SUPERSEDE" || reconcile?.action === "CONFLICT" ? reconcile.atom : undefined;
      const duplicate_of = reconcile?.action === "DUPLICATE" ? reconcile.target_id : undefined;
      results.push({ window: win.id, thread_id: win.thread_id, salience: win.salience_score, extraction, atom, saved, duplicate_of, reconcile });
    }

    console.log(JSON.stringify({
      ok: true,
      command: "lark-cli ingest-chat",
      chat_id: opts.chatId,
      messages: messages.length,
      threads: threads.length,
      thread_linker: llmThreadLink ? { degraded: llmThreadLink.degraded, error: llmThreadLink.error, prompt_version: llmThreadLink.prompt_version } : { degraded: false, method: "heuristic" },
      windows: windows.length,
      processed: results.filter((r) => !r.skipped).length,
      saved_total: results.filter((r) => r.saved).length,
      results,
    }, null, 2));
  });

larkCli
  .command("generate-thread-silver-set")
  .requiredOption("--chat-id <chatId>", "飞书群聊 chat_id（oc_xxx）")
  .requiredOption("--output <path>", "输出 JSONL 路径")
  .option("--profile <profile>", "lark-cli profile 名称")
  .option("--id <id>", "样本 id", `feishu-silver-${Date.now()}`)
  .option("--page-size <size>", "读取消息数量 1-50", "50")
  .option("--start <time>", "起始时间 ISO 8601")
  .option("--end <time>", "结束时间 ISO 8601")
  .option("--label-source <source>", "explicit | llm | hybrid", "hybrid")
  .option("--append", "追加写入 output")
  .description("自动从真实飞书群生成脱敏 thread-linking silver set；不需要人工标注")
  .action(async (opts) => {
    const args = ["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", String(opts.pageSize)];
    if (opts.start) args.push("--start", opts.start);
    if (opts.end) args.push("--end", opts.end);
    if (opts.profile) args.push("--profile", opts.profile);
    const raw = runLarkCliJson(args);
    const messages = toNormalizedMessages(raw, opts.chatId);
    const explicitThreads = threadMessages(messages)
      .filter((thread) => thread.messages.length > 0)
      .map((thread) => ({ id: thread.id, message_ids: thread.messages.map((m) => m.id), topic_hint: thread.topic_hint, confidence: thread.confidence }));
    let labelSource = explicitThreads.every((t) => (t.confidence ?? 0) >= 0.9) ? "explicit_silver" : "heuristic_silver";
    let threads: Array<{ id: string; message_ids: string[]; topic_hint?: string; confidence?: number }> = explicitThreads;
    const hasExplicitLinks = messages.some((m) => !!m.thread_id || !!m.reply_to);
    if (opts.labelSource === "llm" || (opts.labelSource === "hybrid" && !hasExplicitLinks)) {
      const llm = await linkThreadsWithLlm(messages, { timeoutMs: 120_000 });
      if (!llm.degraded) {
        threads = llm.threads;
        labelSource = "llm_silver";
      } else if (opts.labelSource === "llm") {
        throw new Error(`LLM silver labeling failed: ${llm.error}`);
      } else {
        labelSource = `${labelSource}_llm_degraded:${llm.error}`;
      }
    }
    const sample = buildThreadLinkingSilverSample({ id: opts.id, messages, threads, labelSource });
    writeJsonl(opts.output, [sample], !!opts.append);
    console.log(JSON.stringify({ ok: true, command: "lark-cli generate-thread-silver-set", output: opts.output, messages: messages.length, threads: threads.length, label_source: labelSource, sample }, null, 2));
  });

larkCli
  .command("activate-chat")
  .requiredOption("--chat-id <chatId>", "飞书群聊 chat_id（oc_xxx）")
  .option("--profile <profile>", "lark-cli profile 名称")
  .option("--project <project>", "项目名")
  .option("--page-size <size>", "读取消息数量 1-50", "20")
  .option("--start <time>", "起始时间 ISO 8601")
  .option("--end <time>", "结束时间 ISO 8601")
  .option("--min-score <score>", "activation 最低匹配分", "2")
  .option("--send-feishu-webhook", "当建议推送卡片时，通过飞书机器人 webhook 发送")
  .option("--feishu-webhook <url>", "飞书机器人 webhook；也可用 KAIROS_FEISHU_WEBHOOK_URL")
  .option("--activation-throttle <path>", "activation throttle JSONL 路径", "data/activation_throttle.jsonl")
  .option("--cooldown-ms <ms>", "同群同 memory 推卡冷却时间(ms)", "900000")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("读取真实飞书群最近消息，并对每条消息执行 memory activation/Decision Card 判断")
  .action(async (opts) => {
    const args = ["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", String(opts.pageSize)];
    if (opts.start) args.push("--start", opts.start);
    if (opts.end) args.push("--end", opts.end);
    if (opts.profile) args.push("--profile", opts.profile);

    const raw = runLarkCliJson(args);
    const messages = toNormalizedMessages(raw, opts.chatId);
    const store = await storeFromOptions(opts);
    const throttle = new ActivationThrottle(opts.activationThrottle);
    const webhookUrl = opts.sendFeishuWebhook ? (opts.feishuWebhook ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL")) : undefined;
    if (opts.sendFeishuWebhook && !webhookUrl) throw new Error("缺少飞书 webhook：请传 --feishu-webhook 或设置 KAIROS_FEISHU_WEBHOOK_URL");

    const results = [];
    for (const message of messages) {
      const activation = runFeishuWorkflow(store, {
        text: message.text,
        project: opts.project,
        minScore: Number(opts.minScore),
      });
      let sent;
      let throttleDecision;
      let throttleRecord;
      if (activation.action === "push_decision_card" && activation.card && activation.memory_id) {
        throttleDecision = throttle.check({
          chat_id: opts.chatId,
          memory_id: activation.memory_id,
          cooldownMs: Number(opts.cooldownMs),
        });
        if (webhookUrl && throttleDecision.allowed) {
          sent = await sendFeishuInteractiveWebhook(webhookUrl, activation.card);
          if (sent.ok) {
            throttleRecord = throttle.record({ chat_id: opts.chatId, memory_id: activation.memory_id, message_id: message.id });
          }
        }
      }
      results.push({
        message_id: message.id,
        sender: message.sender,
        text: message.text,
        activation,
        throttle: throttleDecision,
        throttle_record: throttleRecord,
        sent,
      });
    }

    console.log(JSON.stringify({
      ok: true,
      command: "lark-cli activate-chat",
      chat_id: opts.chatId,
      messages: messages.length,
      actions: summarizeActivationActions(results.map((r) => r.activation.action)),
      sent_total: results.filter((r) => r.sent?.ok).length,
      webhook: webhookUrl ? redactWebhookUrl(webhookUrl) : undefined,
      results,
    }, null, 2));
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
  .command("card-feedback")
  .argument("<memoryId>")
  .requiredOption("--action <action>", "confirm | ignore | update_requested")
  .option("--user-id <userId>", "反馈用户 ID")
  .option("--message-id <messageId>", "触发反馈的消息/卡片消息 ID")
  .option("--note <note>", "补充说明")
  .option("--refine-queue <path>", "refine queue JSONL 路径", "data/refine_queue.jsonl")
  .option("--no-enqueue-refine", "update_requested 时不加入 refine queue")
  .option("--now <time>", "mock current time, ISO 8601")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("记录决策卡片交互反馈：确认、忽略、请求更新")
  .action(async (memoryId, opts) => {
    if (!["confirm", "ignore", "update_requested"].includes(opts.action)) {
      throw new Error("--action 必须是 confirm | ignore | update_requested");
    }
    const result = applyDecisionCardFeedback(await storeFromOptions(opts), {
      memory_id: memoryId,
      action: opts.action,
      user_id: opts.userId,
      message_id: opts.messageId,
      note: opts.note,
      now: opts.now,
    }, {
      refineQueue: opts.enqueueRefine === false ? undefined : new RefineQueue(opts.refineQueue),
    });
    console.log(JSON.stringify({ ok: result.ok, command: "card-feedback", result }, null, 2));
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

const refine = program
  .command("refine")
  .description("管理 update_requested 产生的记忆修正队列");

refine
  .command("list", { isDefault: true })
  .option("--queue <path>", "refine queue JSONL 路径", "data/refine_queue.jsonl")
  .option("--status <status>", "pending/done/failed")
  .option("--limit <limit>", "返回数量", "20")
  .description("列出 refine job")
  .action((opts) => {
    const queue = new RefineQueue(opts.queue);
    const jobs = queue.list({ status: opts.status, limit: Number(opts.limit) });
    console.log(JSON.stringify({ ok: true, command: "refine list", total: jobs.length, jobs }, null, 2));
  });

refine
  .command("run")
  .option("--queue <path>", "refine queue JSONL 路径", "data/refine_queue.jsonl")
  .option("--limit <limit>", "最多处理 pending job 数", "5")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("保守处理 pending refine job：只标记 awaiting_human_patch，不自动改内容")
  .action(async (opts) => {
    const queue = new RefineQueue(opts.queue);
    const store = await storeFromOptions(opts);
    const jobs = queue.list({ status: "pending", limit: Number(opts.limit) });
    const results = [];
    for (const job of jobs) {
      const triage = triageRefineJob(store, job);
      if (triage.ok) {
        const done = queue.markDone(job, triage);
        results.push({ job_id: job.id, status: done.status, triage });
      } else {
        const failed = queue.markFailed(job, triage.error ?? "unknown_error");
        results.push({ job_id: job.id, status: failed.status, triage });
      }
    }
    console.log(JSON.stringify({ ok: true, command: "refine run", processed: results.length, results }, null, 2));
  });

refine
  .command("apply")
  .argument("<memoryId>")
  .requiredOption("--content <content>", "显式修正后的 MemoryAtom content")
  .option("--job-id <jobId>", "关联 refine job id")
  .option("--user-id <userId>", "执行修正的用户")
  .option("--note <note>", "修正说明")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("显式应用 refine patch；不会自动生成内容")
  .action(async (memoryId, opts) => {
    const result = applyRefinePatch(await storeFromOptions(opts), {
      memory_id: memoryId,
      content: opts.content,
      job_id: opts.jobId,
      user_id: opts.userId,
      note: opts.note,
    });
    console.log(JSON.stringify({ ok: result.ok, command: "refine apply", result }, null, 2));
    if (!result.ok) process.exitCode = 1;
  });

refine
  .command("done")
  .argument("<jobId>")
  .option("--queue <path>", "refine queue JSONL 路径", "data/refine_queue.jsonl")
  .option("--result <json>", "处理结果 JSON 字符串", "{}")
  .description("标记 refine job 已人工/外部处理")
  .action((jobId, opts) => {
    const queue = new RefineQueue(opts.queue);
    const job = queue.get(jobId);
    if (!job) {
      console.log(JSON.stringify({ ok: false, command: "refine done", error: `job 不存在：${jobId}` }, null, 2));
      process.exitCode = 1;
      return;
    }
    const result = queue.markDone(job, JSON.parse(opts.result));
    console.log(JSON.stringify({ ok: true, command: "refine done", job: result }, null, 2));
  });

const induction = program
  .command("induction")
  .description("管理 LLM slow induction/refine 队列");

induction
  .command("list", { isDefault: true })
  .option("--queue <path>", "induction queue JSONL 路径", "data/induction_queue.jsonl")
  .option("--status <status>", "pending/done/failed")
  .option("--limit <limit>", "返回数量", "20")
  .description("列出 induction job")
  .action((opts) => {
    const queue = new InductionQueue(opts.queue);
    const jobs = queue.list({ status: opts.status, limit: Number(opts.limit) });
    console.log(JSON.stringify({ ok: true, command: "induction list", total: jobs.length, jobs }, null, 2));
  });

induction
  .command("run")
  .option("--queue <path>", "induction queue JSONL 路径", "data/induction_queue.jsonl")
  .option("--limit <limit>", "最多处理 pending job 数", "5")
  .option("--project <project>", "项目名")
  .option("--fallback", "LLM 失败时回退规则 baseline")
  .option("--llm-thread-link", "在后台 induction 中使用 LLM 重新链接/补全窗口 evidence，失败则 degraded")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--events <path>", "JSONL event log 路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("异步处理 pending induction job：LLM/refine → Reconcile → 入库")
  .action(async (opts) => {
    const queue = new InductionQueue(opts.queue);
    const store = await storeFromOptions(opts);
    const jobs = queue.list({ status: "pending", limit: Number(opts.limit) });
    const results = [];
    for (const job of jobs) {
      try {
        const threadLink = opts.llmThreadLink && job.context_messages?.length ? await linkThreadsWithLlm(job.context_messages, { timeoutMs: 120_000 }) : undefined;
        const window = threadLink && !threadLink.degraded ? refineWindowWithLlmThread(job.window, job.context_messages ?? [], threadLink.threads) : job.window;
        const result = await extractDecisionWithLlm(window, { fallback: !!opts.fallback });
        const atom = extractionToMemoryAtom(result, window, job.project ?? opts.project);
        const reconcile = atom ? reconcileAndApplyMemoryAtom(store, atom) : { action: "NONE", reason: "extractor_returned_none" };
        const done = queue.markDone(job, { extraction: result, atom, reconcile, thread_linker: threadLink ? { degraded: threadLink.degraded, error: threadLink.error, prompt_version: threadLink.prompt_version } : undefined });
        results.push({ job_id: job.id, status: done.status, extraction_kind: result.kind, thread_linker: threadLink ? { degraded: threadLink.degraded, error: threadLink.error } : undefined, reconcile });
      } catch (error) {
        const failed = queue.markFailed(job, error instanceof Error ? error.message : String(error));
        results.push({ job_id: job.id, status: failed.status, error: failed.error, attempts: failed.attempts });
      }
    }
    console.log(JSON.stringify({ ok: true, command: "induction run", processed: results.length, results }, null, 2));
  });

program
  .command("eval")
  .option("--smoke", "run smoke benchmark")
  .option("--core", "run core benchmark: decision extraction + conflict update + recall")
  .option("--suite <suite>", "run a specific suite: decision-extraction | conflict-update | recall | anti-interference | remind | feishu-workflow | llm-decision-extraction | thread-linking")
  .option("--save <path>", "保存评测结果 JSON，默认 runs/latest-eval.json", "runs/latest-eval.json")
  .description("Run benchmarks")
  .action(async (opts) => {
    if (opts.smoke) {
      const cases = loadSmokeCases();
      const output = { ok: true, command: "eval", mode: "smoke", at: new Date().toISOString(), smoke: true, ...summarizeSmokeCases(cases) };
      saveEvalOutput(opts.save, output);
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    if (opts.core) {
      const results = runAllCoreEvals();
      const output = { ok: true, command: "eval", mode: "core", at: new Date().toISOString(), core: true, results };
      saveEvalOutput(opts.save, output);
      console.log(JSON.stringify(output, null, 2));
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
                    : opts.suite === "thread-linking"
                      ? await runThreadLinkingEval()
                      : undefined;
      if (!result) throw new Error(`未知 suite: ${opts.suite}`);
      const output = { ok: true, command: "eval", mode: opts.suite, at: new Date().toISOString(), result };
      saveEvalOutput(opts.save, output);
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    const output = { ok: true, command: "eval", mode: "empty", at: new Date().toISOString(), smoke: false, cases: 0 };
    saveEvalOutput(opts.save, output);
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("dashboard")
  .option("--serve", "启动只读 dashboard HTTP 服务")
  .option("--port <port>", "服务端口", "8787")
  .option("--output <path>", "输出自包含 HTML 文件", "runs/kairos-engine-dashboard.html")
  .option("--events <path>", "Memory EventLog 路径", "data/memory_events.jsonl")
  .option("--induction-queue <path>", "Induction queue JSONL 路径", "data/induction_queue.jsonl")
  .option("--refine-queue <path>", "Refine queue JSONL 路径", "data/refine_queue.jsonl")
  .option("--activation-throttle <path>", "Activation throttle JSONL 路径", "data/activation_throttle.jsonl")
  .option("--runtime-log <path>", "lark-runtime JSONL 日志路径", "runs/lark-runtime.jsonl")
  .option("--hook-log <path>", "兼容旧参数：OpenClaw hook log 路径")
  .option("--eval-result <path>", "本地评测结果 JSON 路径", "runs/latest-eval.json")
  .option("--db <path>", "SQLite/JSONL 数据路径")
  .option("--store <kind>", "存储后端 jsonl/sqlite，默认 jsonl")
  .description("生成/启动 Kairos 引擎工作可视化页面；只读，不污染飞书群")
  .action(async (opts) => {
    const store = await storeFromOptions(opts);
    const options = {
      store,
      eventsPath: opts.events,
      inductionQueuePath: opts.inductionQueue,
      refineQueuePath: opts.refineQueue,
      activationThrottlePath: opts.activationThrottle,
      runtimeLogPath: opts.runtimeLog ?? opts.hookLog,
      evalResultPath: opts.evalResult,
    };
    if (opts.serve) {
      const server = await serveEngineDashboard({ ...options, port: Number(opts.port), refreshSeconds: 2 });
      console.log(JSON.stringify({ ok: true, command: "dashboard", mode: "serve", url: server.url }, null, 2));
      return;
    }
    const data = buildEngineDashboardData(options);
    writeEngineDashboardHtml(data, opts.output);
    console.log(JSON.stringify({ ok: true, command: "dashboard", mode: "write", output: opts.output, memories: data.memories.length, induction_jobs: data.induction_jobs.length, refine_jobs: data.refine_jobs.length }, null, 2));
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
