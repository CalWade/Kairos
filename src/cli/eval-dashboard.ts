import type { Command } from "commander";
import { loadSmokeCases, summarizeSmokeCases } from "../eval/smoke.js";
import {
  runAllCoreEvals,
  runAntiInterferenceEval,
  runConflictUpdateEval,
  runDecisionExtractionEval,
  runFeishuWorkflowEval,
  runLlmDecisionExtractionEval,
  runRecallEval,
  runRemindEval,
  runThreadLinkingEval,
} from "../eval/runner.js";
import {
  buildEngineDashboardData,
  serveEngineDashboard,
  writeEngineDashboardHtml,
} from "../visualization/dashboard.js";
import { saveEvalOutput, storeFromOptions } from "./helpers.js";

export function register(program: Command) {
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
      console.log(JSON.stringify({
        ok: true,
        command: "dashboard",
        mode: "write",
        output: opts.output,
        memories: data.memories.length,
        induction_jobs: data.induction_jobs.length,
        refine_jobs: data.refine_jobs.length,
      }, null, 2));
    });
}
