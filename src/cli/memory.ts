import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { createManualMemory } from "../memory/factory.js";
import { applyDecisionCardFeedback } from "../memory/cardFeedback.js";
import { buildDecisionCard, renderDecisionCardFeishuPayload, renderDecisionCardMarkdown } from "../memory/decisionCard.js";
import { formatRecallAnswer } from "../memory/recallFormatter.js";
import { createAtomFromFact, extractFacts, reconcileFact } from "../extractor/mockExtractor.js";
import { redactWebhookUrl, sendFeishuInteractiveWebhook } from "../feishuWebhook.js";
import { loadEnvValue } from "../llm/config.js";
import { RefineQueue } from "../refine/queue.js";
import { storeFromOptions } from "./helpers.js";

/**
 * 注册 MemoryAtom 的直接 CRUD / 卡片渲染 / 反馈命令。
 * 不含 LLM 抽取路径（在 extract 组里），不含 feishu 激活工作流（在 workflow 组里）。
 */
export function register(program: Command) {
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
}
