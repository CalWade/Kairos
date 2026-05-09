import type { Command } from "commander";
import { existsSync } from "node:fs";
import { extractDecisionBaseline } from "../extractor/ruleDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import {
  checkLarkCliStatus,
  extractTextsFromLarkCliJson,
  preflightLarkCliPurpose,
  runLarkCliJson,
} from "../larkCliAdapter.js";
import { describeLlmConfig, testLlmConnection } from "../llm/config.js";
import { MemoryAtomSchema } from "../memory/schema.js";
import { runFeishuWorkflow } from "../workflow/feishuWorkflow.js";
import { storeFromOptions } from "./helpers.js";

type DoctorCheck = { name: string; ok: boolean; detail?: unknown; next?: string };
type DoctorReport = { ok: boolean; profile: string; chat_id?: string; checks: DoctorCheck[] };

/**
 * 安装 / 诊断 / 配置检查类命令：面向 OpenClaw Agent 接入仓库后的验收。
 */
export function register(program: Command) {
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
      const checks: DoctorCheck[] = [];
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

      if (opts.chatId) {
        try {
          const raw = runLarkCliJson(["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", "5", "--profile", opts.profile]);
          const texts = extractTextsFromLarkCliJson(raw);
          checks.push({ name: "read chat messages", ok: true, detail: { ok: true, text_count: texts.length } });
        } catch (error) {
          checks.push({ name: "read chat messages", ok: false, detail: { ok: false, error: String(error) }, next: "确认 chat_id、profile 权限、用户是否在群内" });
        }
        if (opts.e2e) {
          try {
            const store = await storeFromOptions(opts);
            const raw = runLarkCliJson(["im", "+chat-messages-list", "--chat-id", opts.chatId, "--format", "json", "--page-size", "20", "--profile", opts.profile]);
            const texts = extractTextsFromLarkCliJson(raw);
            let savedTotal = 0;
            for (const item of texts) {
              const window = {
                id: item.id,
                segment_id: item.id,
                topic_hint: "doctor-e2e",
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
              if (atom) { store.upsert(atom); savedTotal += 1; }
            }
            const workflow = runFeishuWorkflow(store, { text: opts.triggerText, project: opts.project });
            const e2e = { ok: workflow.action === "push_decision_card", read_total: texts.length, saved_total: savedTotal, workflow_action: workflow.action, memory_id: workflow.memory_id };
            checks.push({ name: "e2e chat -> memory -> workflow", ok: workflow.action === "push_decision_card", detail: e2e, next: "群里需存在可抽取的历史决策，并用相关 trigger-text 验证" });
          } catch (error) {
            checks.push({ name: "e2e chat -> memory -> workflow", ok: false, detail: { ok: false, error: String(error) }, next: "先跑 memoryops lark-cli e2e-chat 定位详情" });
          }
        }
      }

      const requiredOk = checks.filter((c) => !c.name.includes("optional")).every((c) => c.ok);
      const report: DoctorReport = { ok: requiredOk, profile: opts.profile, chat_id: opts.chatId, checks };
      if (opts.pretty) console.log(renderDoctorPretty(report));
      else console.log(JSON.stringify({ ok: requiredOk, command: "doctor", profile: report.profile, chat_id: report.chat_id, checks: report.checks }, null, 2));
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
      const steps: Array<{ id: string; status: "done" | "todo"; command?: string; userAction?: string; note?: string }> = [];
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

  program
    .command("llm:check")
    .option("--test", "实际请求一次模型，验证连通性")
    .description("检查 Kairos LLM 配置；真实群聊解缠和慢速归纳依赖该配置")
    .action(async (opts) => {
      const config = describeLlmConfig();
      const connection = opts.test ? await testLlmConnection() : undefined;
      const ok = config.ok && (!opts.test || !!connection?.ok);
      console.log(JSON.stringify({ ok, command: "llm:check", config, connection, next: ok ? undefined : "配置 .env: KAIROS_LLM_BASE_URL / KAIROS_LLM_API_KEY / KAIROS_LLM_MODEL" }, null, 2));
      if (!ok) process.exitCode = 1;
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
}

function renderDoctorPretty(report: DoctorReport): string {
  const lines: string[] = [
    `Kairos doctor (${report.profile})`,
    `Status: ${report.ok ? "READY" : "NEEDS_ACTION"}`,
  ];
  if (report.chat_id) lines.push(`Chat: ${report.chat_id}`);
  lines.push("");
  for (const check of report.checks) {
    const optional = check.name.includes("optional");
    const icon = check.ok ? "✅" : optional ? "⚠️" : "❌";
    lines.push(`${icon} ${check.name}`);
    if (!check.ok && check.next) lines.push(`   next: ${check.next}`);
    if (check.detail && (check.name.includes("e2e") || check.name.includes("read chat"))) {
      lines.push(`   detail: ${JSON.stringify(check.detail)}`);
    }
  }
  lines.push("", report.ok ? "Ready for lark-cli demo." : "Fix required checks above, then rerun doctor.");
  return lines.join("\n");
}
