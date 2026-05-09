import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { buildCandidateWindows } from "../candidate/window.js";
import { normalizeFeishuChatExport } from "../candidate/feishuChatExport.js";
import { segmentMessages } from "../candidate/segment.js";
import { mergeAdjacentScoredSegments, scoreSegments } from "../candidate/salience.js";
import { extractDecisionBaseline } from "../extractor/ruleDecisionExtractor.js";
import { extractDecisionWithLlm } from "../extractor/llmDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import { storeFromOptions } from "./helpers.js";

/**
 * 抽取/分段命令：输入纯文本或飞书导出 Markdown，产出候选窗口或 MemoryAtom。
 * lark-cli runtime / ingest-chat 路径不在此处（在 lark-cli 组里）。
 */
export function register(program: Command) {
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
}
