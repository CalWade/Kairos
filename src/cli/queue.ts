import type { Command } from "commander";
import { linkThreadsWithLlm } from "../candidate/llmThreadLinker.js";
import { extractDecisionWithLlm } from "../extractor/llmDecisionExtractor.js";
import { extractionToMemoryAtom } from "../extractor/toMemoryAtom.js";
import { InductionQueue } from "../induction/queue.js";
import { reconcileAndApplyMemoryAtom } from "../memory/reconcile.js";
import { RefineQueue } from "../refine/queue.js";
import { applyRefinePatch, triageRefineJob } from "../refine/processor.js";
import { refineWindowWithLlmThread, storeFromOptions } from "./helpers.js";

/**
 * 三个后台队列的命令组：
 * - remind（review_at 到期）
 * - refine（update_requested 触发的人工修正）
 * - induction（LLM slow induction，飞书 runtime 离线补抽）
 */
export function register(program: Command) {
  registerRemind(program);
  registerRefine(program);
  registerInduction(program);
}

function registerRemind(program: Command) {
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
}

function registerRefine(program: Command) {
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
}

function registerInduction(program: Command) {
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
          const threadLink = opts.llmThreadLink && job.context_messages?.length
            ? await linkThreadsWithLlm(job.context_messages, { timeoutMs: 120_000 })
            : undefined;
          const window = threadLink && !threadLink.degraded
            ? refineWindowWithLlmThread(job.window, job.context_messages ?? [], threadLink.threads)
            : job.window;
          const result = await extractDecisionWithLlm(window, { fallback: !!opts.fallback });
          const atom = extractionToMemoryAtom(result, window, job.project ?? opts.project);
          const reconcile = atom
            ? reconcileAndApplyMemoryAtom(store, atom)
            : { action: "NONE", reason: "extractor_returned_none" };
          const done = queue.markDone(job, {
            extraction: result,
            atom,
            reconcile,
            thread_linker: threadLink
              ? { degraded: threadLink.degraded, error: threadLink.error, prompt_version: threadLink.prompt_version }
              : undefined,
          });
          results.push({
            job_id: job.id,
            status: done.status,
            extraction_kind: result.kind,
            thread_linker: threadLink ? { degraded: threadLink.degraded, error: threadLink.error } : undefined,
            reconcile,
          });
        } catch (error) {
          const failed = queue.markFailed(job, error instanceof Error ? error.message : String(error));
          results.push({ job_id: job.id, status: failed.status, error: failed.error, attempts: failed.attempts });
        }
      }
      console.log(JSON.stringify({ ok: true, command: "induction run", processed: results.length, results }, null, 2));
    });
}
