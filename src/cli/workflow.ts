import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { redactWebhookUrl, sendFeishuInteractiveWebhook } from "../feishuWebhook.js";
import { loadEnvValue } from "../llm/config.js";
import { runFeishuWorkflow } from "../workflow/feishuWorkflow.js";
import { storeFromOptions } from "./helpers.js";

/**
 * 飞书工作流单文本 + 反馈命令。真实 lark-cli runtime 路径在 lark-cli.ts。
 */
export function register(program: Command) {
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
}
