import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { linkThreadsWithLlm } from "../candidate/llmThreadLinker.js";
import { threadMessages } from "../candidate/thread.js";
import { buildCandidateWindowFromThread } from "../candidate/window.js";
import { extractDecisionBaseline } from "../extractor/ruleDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import { redactWebhookUrl, sendFeishuInteractiveWebhook } from "../feishuWebhook.js";
import { InductionQueue } from "../induction/queue.js";
import {
  buildLarkCliPlan,
  checkLarkCliStatus,
  extractChatInfoFromLarkCliJson,
  extractTextsFromLarkCliJson,
  preflightLarkCliPurpose,
  runLarkCliJson,
  toNormalizedMessages,
} from "../larkCliAdapter.js";
import { runLarkRuntime } from "../larkRuntime/worker.js";
import { describeLlmConfig, loadEnvValue, testLlmConnection } from "../llm/config.js";
import { reconcileAndApplyMemoryAtom } from "../memory/reconcile.js";
import { ActivationThrottle } from "../workflow/activationThrottle.js";
import { runFeishuWorkflow } from "../workflow/feishuWorkflow.js";
import {
  buildThreadLinkingSilverSample,
  collectLlmConfigInteractively,
  conversationThreadsFromLlm,
  nonEmpty,
  storeFromOptions,
  summarizeActivationActions,
  upsertEnvFile,
  writeJsonl,
} from "./helpers.js";

/**
 * lark-cli 子命令组：飞书 runtime 接入、消息读取、抽取、激活。
 * 10 个子命令：runtime-setup / runtime / status / preflight / e2e-chat /
 *             ingest-chat / generate-thread-silver-set / activate-chat /
 *             ingest-file / plan
 */
export function register(program: Command) {
  const larkCli = program
    .command("lark-cli")
    .description("官方 lark-cli 适配层（当前仅做本地状态检查，不触发授权或数据读取）");

  registerRuntimeSetup(larkCli);
  registerRuntime(larkCli);
  registerStatus(larkCli);
  registerPreflight(larkCli);
  registerE2eChat(larkCli);
  registerIngestChat(larkCli);
  registerGenerateThreadSilverSet(larkCli);
  registerActivateChat(larkCli);
  registerIngestFile(larkCli);
  registerPlan(larkCli);
}

function registerRuntimeSetup(larkCli: Command) {
  larkCli
    .command("runtime-setup")
    .option("--profile <profile>", "lark-cli profile", "kairos-alt")
    .option("--chat-id <chatId>", "要监听的飞书群 chat_id；也可读取 KAIROS_CHAT_ID")
    .option("--feishu-webhook <url>", "飞书机器人 webhook；也可读取 KAIROS_FEISHU_WEBHOOK_URL")
    .option("--chat-name <name>", "可选：目标群名称；不传时尽量通过 lark-cli chat-list 自动解析")
    .option("--write-env", "把 profile/chat_id/webhook 写入 .env")
    .option("--test-read", "测试读取目标群最近消息")
    .option("--test-webhook", "发送一条测试卡片到 webhook 绑定群")
    .option("--llm-base-url <url>", "LLM OpenAI-compatible base URL，写入 KAIROS_LLM_BASE_URL")
    .option("--llm-api-key <key>", "LLM API Key，写入 KAIROS_LLM_API_KEY")
    .option("--llm-model <model>", "LLM 模型名，写入 KAIROS_LLM_MODEL")
    .option("--skip-llm", "暂时跳过 LLM 配置；runtime 会降级使用 fallback")
    .option("--test-llm", "实际请求一次 LLM，验证模型连通性")
    .description("lark-runtime 接入向导：检查 lark-cli/profile/chat_id/webhook，并可写入 .env")
    .action(async (opts) => {
      const profile = nonEmpty(opts.profile) ?? loadEnvValue("KAIROS_LARK_PROFILE") ?? "kairos-alt";
      const chatId = nonEmpty(opts.chatId) ?? loadEnvValue("KAIROS_CHAT_ID");
      const webhook = nonEmpty(opts.feishuWebhook) ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL");
      let chatName = nonEmpty(opts.chatName) ?? loadEnvValue("KAIROS_CHAT_NAME");
      const llmCliValues = {
        ...(nonEmpty(opts.llmBaseUrl) ? { KAIROS_LLM_BASE_URL: nonEmpty(opts.llmBaseUrl)! } : {}),
        ...(nonEmpty(opts.llmApiKey) ? { KAIROS_LLM_API_KEY: nonEmpty(opts.llmApiKey)! } : {}),
        ...(nonEmpty(opts.llmModel) ? { KAIROS_LLM_MODEL: nonEmpty(opts.llmModel)! } : {}),
      };
      if (opts.writeEnv && Object.keys(llmCliValues).length) upsertEnvFile(".env", llmCliValues);

      let llmSkipped = !!opts.skipLlm;
      let llmPromptValues: Record<string, string> | undefined;
      let llmConfig = describeLlmConfig();
      if (opts.writeEnv && !llmConfig.ok && !llmSkipped && process.stdin.isTTY) {
        llmPromptValues = await collectLlmConfigInteractively();
        if (llmPromptValues) {
          upsertEnvFile(".env", llmPromptValues);
          llmConfig = describeLlmConfig();
        } else {
          llmSkipped = true;
        }
      }

      const status = checkLarkCliStatus({ checkAuth: true, profile });
      const preflight = preflightLarkCliPurpose("chat_messages", { profile });
      const checks: Array<{ name: string; ok: boolean; detail?: unknown; next?: string }> = [];
      checks.push({ name: "lark-cli installed", ok: status.installed, detail: status.version, next: "npm install -g @larksuite/cli" });
      checks.push({ name: "lark-cli profile authorized", ok: !!status.auth_ok, detail: status.auth_summary, next: `lark-cli auth login --recommend --profile ${profile}  # 按官方引导保持进程等待，不要反复 config init --new` });
      checks.push({ name: "chat_messages scope", ok: preflight.missing_scopes.length === 0, detail: { missing_scopes: preflight.missing_scopes }, next: preflight.recommended_command?.join(" ") });
      checks.push({ name: "KAIROS_CHAT_ID", ok: !!chatId, detail: chatId, next: `lark-cli im +chat-list --format json --profile ${profile}` });
      checks.push({ name: "KAIROS_FEISHU_WEBHOOK_URL", ok: !!webhook, detail: webhook ? redactWebhookUrl(webhook) : undefined, next: "在目标飞书群添加自定义机器人，复制 webhook" });
      checks.push({
        name: "LLM config",
        ok: llmConfig.ok || llmSkipped,
        detail: { base_url: llmConfig.baseUrl, model: llmConfig.model, has_api_key: llmConfig.hasApiKey, missing: llmConfig.missing, skipped: llmSkipped },
        next: llmSkipped
          ? "已暂时跳过 LLM；真实群聊会话解缠和慢速归纳会降级，建议正式演示前补齐配置。"
          : "现在填写：直接运行 npm run setup:lark-runtime -- ...，按提示输入；或传 --llm-base-url / --llm-api-key / --llm-model；也可用 --skip-llm 暂时跳过。",
      });

      if (opts.testLlm) {
        const llmTest = await testLlmConnection();
        checks.push({ name: "LLM connection", ok: llmTest.ok, detail: llmTest, next: "检查模型地址、API Key、模型名和网络连通性" });
      }

      if (chatId && !chatName) {
        try {
          const chatListRaw = runLarkCliJson(["im", "+chat-list", "--format", "json", "--profile", profile]);
          chatName = extractChatInfoFromLarkCliJson(chatListRaw, chatId)?.name;
        } catch {}
      }

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
          ...(chatName ? { KAIROS_CHAT_NAME: chatName } : {}),
          ...(webhook ? { KAIROS_FEISHU_WEBHOOK_URL: webhook } : {}),
          ...(llmPromptValues ?? {}),
          ...llmCliValues,
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
        chat_name: chatName,
        checks,
        official_lark_cli_auth_note: "授权请按 lark-cli 官方 auth login 页面完成；不要反复运行 config init --new；授权命令需要保持运行直到成功返回。",
        llm_skipped: llmSkipped,
        next: ok ? (llmSkipped ? ["npm run dashboard", "npm run lark-runtime", "建议正式演示前补齐 LLM 配置"] : ["npm run dashboard", "npm run lark-runtime"]) : checks.find((c) => !c.ok)?.next,
      }, null, 2));
    });
}

function registerRuntime(larkCli: Command) {
  larkCli
    .command("runtime")
    .option("--chat-id <chatId>", "飞书群聊 chat_id；也可用 KAIROS_CHAT_ID")
    .option("--profile <profile>", "lark-cli profile；也可用 KAIROS_LARK_PROFILE")
    .option("--chat-name <name>", "飞书群名称；也可用 KAIROS_CHAT_NAME，用于 Dashboard 展示")
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
        chatName: nonEmpty(opts.chatName) ?? loadEnvValue("KAIROS_CHAT_NAME"),
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
}

function registerStatus(larkCli: Command) {
  larkCli
    .command("status")
    .option("--check-auth", "同时检查 lark-cli auth status（不发起登录）")
    .option("--profile <profile>", "lark-cli profile 名称")
    .description("检查官方 lark-cli 是否安装及认证状态")
    .action((opts) => {
      console.log(JSON.stringify({ ok: true, command: "lark-cli status", status: checkLarkCliStatus({ checkAuth: !!opts.checkAuth, profile: opts.profile }) }, null, 2));
    });
}

function registerPreflight(larkCli: Command) {
  larkCli
    .command("preflight")
    .requiredOption("--purpose <purpose>", "chat_messages/message_search/doc_fetch/event_consume")
    .option("--profile <profile>", "lark-cli profile 名称")
    .description("检查某类 lark-cli 数据获取所需授权是否满足")
    .action((opts) => {
      console.log(JSON.stringify({ ok: true, command: "lark-cli preflight", preflight: preflightLarkCliPurpose(opts.purpose, { profile: opts.profile }) }, null, 2));
    });
}

function registerE2eChat(larkCli: Command) {
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
}

function registerIngestChat(larkCli: Command) {
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

      const raw = runLarkCliJson(args);
      const messages = toNormalizedMessages(raw, opts.chatId);
      const llmThreadLink = opts.llmThreadLink ? await linkThreadsWithLlm(messages) : undefined;
      const threads = llmThreadLink && !llmThreadLink.degraded
        ? conversationThreadsFromLlm(messages, llmThreadLink.threads)
        : threadMessages(messages, { max_gap_ms: Number(opts.threadGap) });
      const windows = threads.map((t) => buildCandidateWindowFromThread(t));

      // 只入 slow induction 队列，不实时抽取
      if (opts.enqueueInduction) {
        const queue = new InductionQueue(opts.inductionQueue);
        const jobs = windows
          .filter((win) => win.has_resolution_cue || win.salience_score >= 5)
          .map((win) => queue.enqueue(toLegacyWindow(win), { project: opts.project, contextMessages: messages }));
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

      const store = opts.write ? await storeFromOptions(opts) : undefined;
      const results = [];
      for (const win of windows) {
        if (!win.has_resolution_cue && win.salience_score < 5) {
          results.push({ window: win.id, skipped: true, reason: "no_resolution_cue_and_low_salience" });
          continue;
        }
        const legacy = toLegacyWindow(win);
        const extraction = extractDecisionBaseline(legacy);
        const atom = extractionToMemoryAtom(extraction, legacy, opts.project);
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
}

/**
 * 把从 thread 构造出的 window 适配到历史 CandidateWindow 结构（带 source_channel）。
 * 之前在 ingest-chat 里 inline 重复了两次，抽到这里。
 */
function toLegacyWindow(win: ReturnType<typeof buildCandidateWindowFromThread>) {
  return {
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
    source_channel: "feishu" as const,
    source_type: "feishu_message" as const,
  };
}

function registerGenerateThreadSilverSet(larkCli: Command) {
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
      console.log(JSON.stringify({
        ok: true,
        command: "lark-cli generate-thread-silver-set",
        output: opts.output,
        messages: messages.length,
        threads: threads.length,
        label_source: labelSource,
        sample,
      }, null, 2));
    });
}

function registerActivateChat(larkCli: Command) {
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
}

function registerIngestFile(larkCli: Command) {
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
}

function registerPlan(larkCli: Command) {
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
      console.log(JSON.stringify({
        ok: true,
        command: "lark-cli plan",
        plan: buildLarkCliPlan({
          purpose: opts.purpose,
          chatId: opts.chatId,
          query: opts.query,
          docUrl: opts.docUrl,
          eventKey: opts.eventKey,
          since: opts.since,
          until: opts.until,
          profile: opts.profile,
        }),
      }, null, 2));
    });
}
