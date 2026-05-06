import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { EventLog } from "../memory/eventLog.js";
import type { MemoryAtom } from "../memory/atom.js";
import type { MemoryStoreLike } from "../memory/storeFactory.js";
import { InductionQueue } from "../induction/queue.js";
import { RefineQueue } from "../refine/queue.js";
import { ActivationThrottle } from "../workflow/activationThrottle.js";

export type EngineDashboardOptions = {
  store: MemoryStoreLike;
  eventsPath?: string;
  inductionQueuePath?: string;
  refineQueuePath?: string;
  activationThrottlePath?: string;
  runtimeLogPath?: string;
  evalResultPath?: string;
};

export type EngineDashboardData = {
  generated_at: string;
  memories: MemoryAtom[];
  events: unknown[];
  induction_jobs: unknown[];
  refine_jobs: unknown[];
  activations: unknown[];
  runtime_logs: unknown[];
  eval_results: unknown[];
};

export function buildEngineDashboardData(options: EngineDashboardOptions): EngineDashboardData {
  const eventsPath = options.eventsPath ?? "data/memory_events.jsonl";
  const inductionQueuePath = options.inductionQueuePath ?? "data/induction_queue.jsonl";
  const refineQueuePath = options.refineQueuePath ?? "data/refine_queue.jsonl";
  const activationThrottlePath = options.activationThrottlePath ?? "data/activation_throttle.jsonl";
  const runtimeLogPath = options.runtimeLogPath ?? "runs/lark-runtime.jsonl";
  const evalResultPath = options.evalResultPath ?? "runs/latest-eval.json";
  const throttle = new ActivationThrottle(activationThrottlePath);
  return {
    generated_at: new Date().toISOString(),
    memories: options.store.list({ includeHistory: true, limit: 100 }),
    events: new EventLog(eventsPath).readAll().slice(-100),
    induction_jobs: new InductionQueue(inductionQueuePath).list({ limit: 100 }),
    refine_jobs: new RefineQueue(refineQueuePath).list({ limit: 100 }),
    activations: [...throttle.latest().values()],
    runtime_logs: readJsonlSafe(runtimeLogPath).slice(-100),
    eval_results: readEvalResults(evalResultPath).slice(-20),
  };
}

export function writeEngineDashboardHtml(data: EngineDashboardData, outputPath: string, options: { refreshSeconds?: number } = {}) {
  const dir = dirname(outputPath);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, renderEngineDashboardHtml(data, options), "utf8");
}

export function renderEngineDashboardHtml(data: EngineDashboardData, options: { refreshSeconds?: number } = {}): string {
  const latestRuntime = data.runtime_logs.slice(-8).reverse();
  const latestRuntimeLabel = typeof (latestRuntime[0] as any)?.chat_label === "string"
    ? (latestRuntime[0] as any).chat_label
    : typeof (latestRuntime[0] as any)?.chat_name === "string"
      ? `${(latestRuntime[0] as any).chat_name} (${(latestRuntime[0] as any).chat_id ?? ""})`
      : typeof (latestRuntime[0] as any)?.chat_id === "string"
        ? (latestRuntime[0] as any).chat_id
        : "等待 runtime 日志";
  const latestEvents = data.events.slice(-8).reverse();
  const latestEval = data.eval_results.slice(-3).reverse();
  const induction = data.induction_jobs as any[];
  const refine = data.refine_jobs as any[];
  const activeMemories = data.memories.filter((m) => m.status === "active").slice(0, 12);
  const pendingRefine = refine.filter((j) => j.status === "pending");
  const pendingInduction = induction.filter((j) => j.status === "pending");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ""}
  <title>Kairos 引擎工作流可视化</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --card:#111a2e; --card2:#17223a; --text:#e8eefc; --muted:#91a1bd; --ok:#3ddc97; --warn:#ffd166; --bad:#ff6b6b; --blue:#70a1ff; --purple:#b388ff; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top left, #1b2b52, var(--bg)); color: var(--text); }
    header { padding: 28px 32px 16px; display:flex; align-items:flex-end; justify-content:space-between; gap: 20px; }
    h1 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
    h2 { margin: 0 0 14px; font-size: 17px; color: #fff; }
    .sub { color: var(--muted); margin-top: 6px; }
    .grid { display:grid; grid-template-columns: repeat(12, 1fr); gap: 16px; padding: 16px 32px 32px; }
    .card { background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.02)); border: 1px solid rgba(255,255,255,.09); border-radius: 18px; padding: 18px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
    .span3 { grid-column: span 3; } .span4 { grid-column: span 4; } .span5 { grid-column: span 5; } .span6 { grid-column: span 6; } .span7 { grid-column: span 7; } .span8 { grid-column: span 8; } .span12 { grid-column: span 12; }
    .metric { font-size: 34px; font-weight: 750; }
    .metric small { font-size: 13px; color: var(--muted); font-weight:500; }
    .pill { display:inline-flex; align-items:center; border-radius:999px; padding:4px 9px; font-size:12px; margin: 2px 4px 2px 0; background:#22304f; color:#c7d6ff; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .blue { color: var(--blue); }
    .flow { position:relative; display:grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap:18px; padding: 12px 0 4px; }
    .flow::before { content:""; position:absolute; left:8%; right:8%; top:51%; height:3px; background:linear-gradient(90deg, var(--blue), var(--purple), var(--ok)); opacity:.55; box-shadow:0 0 18px rgba(112,161,255,.45); animation: flowline 2.2s linear infinite; }
    .node { position:relative; z-index:1; min-height:132px; padding:16px; border-radius:18px; background:rgba(23,34,58,.92); border:1px solid rgba(255,255,255,.09); overflow:hidden; }
    .node::after { content:""; position:absolute; inset:-40%; background:radial-gradient(circle, rgba(112,161,255,.22), transparent 38%); opacity:.55; animation:pulse 2.6s ease-in-out infinite; }
    .node h3 { position:relative; z-index:1; margin:0 0 8px; font-size:15px; }
    .node .big { position:relative; z-index:1; font-size:32px; font-weight:800; margin:4px 0; }
    .node .desc { position:relative; z-index:1; color:var(--muted); font-size:12px; line-height:1.45; }
    .node.active { border-color:rgba(61,220,151,.5); box-shadow:0 0 28px rgba(61,220,151,.12); }
    .node.warn { border-color:rgba(255,209,102,.55); }
    @keyframes pulse { 0%,100% { transform:scale(.8); opacity:.25; } 50% { transform:scale(1.05); opacity:.65; } }
    @keyframes flowline { 0% { filter:hue-rotate(0deg); opacity:.35; } 50% { opacity:.8; } 100% { filter:hue-rotate(60deg); opacity:.35; } }
    table { width:100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align:left; padding:9px 8px; border-bottom:1px solid rgba(255,255,255,.07); vertical-align:top; }
    th { color:#b8c5dd; font-weight:600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#dbe7ff; }
    .muted { color: var(--muted); }
    pre { white-space:pre-wrap; word-break:break-word; margin:0; font-size:12px; color:#dbe7ff; }
    @media (max-width: 980px) { .span3,.span4,.span5,.span6,.span7,.span8,.span12 { grid-column: span 12; } header { flex-direction:column; align-items:flex-start; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Kairos 引擎工作流可视化</h1>
      <div class="sub">旁路观察真实数据流 · 不向飞书群发送调试消息 · 追踪从群聊到长期记忆的每一步</div>
    </div>
    <div class="sub mono">刷新时间 ${escapeHtml(data.generated_at)}</div>
  </header>

  <main class="grid">
    <section class="card span3"><div class="metric">${data.memories.length}<br/><small>记忆总数</small></div></section>
    <section class="card span3"><div class="metric ok">${activeMemories.length}<br/><small>当前有效记忆</small></div></section>
    <section class="card span3"><div class="metric ${pendingInduction.length ? "warn" : "ok"}">${pendingInduction.length}<br/><small>待归纳任务</small></div></section>
    <section class="card span3"><div class="metric ${pendingRefine.length ? "warn" : "ok"}">${pendingRefine.length}<br/><small>待修正任务</small></div></section>

    <section class="card span12">
      <h2>真实工作流数据流</h2>
      <div class="flow">
        ${flowNode("① 飞书消息进入", latestRuntime.length, `来源：${latestRuntimeLabel}`, latestRuntime.length > 0)}
        ${flowNode("② 会话解缠与归纳", induction.length, "LLM thread linking 与 induction queue 在后台理解上下文", induction.length > 0, pendingInduction.length > 0)}
        ${flowNode("③ 长期记忆生成", activeMemories.length, "MemoryAtom 保存决策、风险、约定及证据链", activeMemories.length > 0)}
        ${flowNode("④ 历史记忆激活", data.activations.length, "后续群聊触及历史决策时触发卡片提醒", data.activations.length > 0)}
        ${flowNode("⑤ 反馈与修正", refine.length, "确认、忽略、请求更新进入 refine queue", refine.length > 0, pendingRefine.length > 0)}
      </div>
    </section>

    <section class="card span7">
      <h2>当前有效记忆</h2>
      ${memoryTable(activeMemories)}
    </section>

    <section class="card span5">
      <h2>后台队列</h2>
      ${queueTable("归纳队列", induction.slice(-8).reverse())}
      <div style="height:14px"></div>
      ${queueTable("修正队列", refine.slice(-8).reverse())}
    </section>

    <section class="card span6">
      <h2>最近飞书入口 / 激活日志</h2>
      <div class="muted" style="margin-bottom:10px">最新来源：${escapeHtml(latestRuntimeLabel)}</div>
      ${logTable(latestRuntime)}
    </section>

    <section class="card span6">
      <h2>最近记忆事件</h2>
      ${logTable(latestEvents)}
    </section>

    <section class="card span12">
      <h2>本地评测结果</h2>
      ${evalTable(latestEval)}
    </section>
  </main>
</body>
</html>`;
}

export async function serveEngineDashboard(options: EngineDashboardOptions & { port?: number; refreshSeconds?: number }) {
  const port = options.port ?? 8787;
  const server = createServer((_, res) => {
    try {
      const data = buildEngineDashboardData(options);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderEngineDashboardHtml(data, { refreshSeconds: options.refreshSeconds ?? 2 }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, url: `http://127.0.0.1:${port}` };
}

function flowNode(title: string, count: number, desc: string, active: boolean, warn = false): string {
  return `<div class="node ${active ? "active" : ""} ${warn ? "warn" : ""}"><h3>${escapeHtml(title)}</h3><div class="big">${count}</div><div class="desc">${escapeHtml(desc)}</div></div>`;
}

function step(n: string, title: string, detail: string): string {
  return `<div class="step"><b><span class="pill">${n}</span>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`;
}

function memoryTable(memories: MemoryAtom[]): string {
  if (!memories.length) return `<div class="muted">暂无有效记忆</div>`;
  return `<table><thead><tr><th>类型</th><th>主题</th><th>内容</th><th>状态</th></tr></thead><tbody>${memories.map((m) => `<tr><td><span class="pill">${escapeHtml(m.type)}</span></td><td class="mono">${escapeHtml(m.subject)}</td><td>${escapeHtml(short(m.content, 150))}</td><td>${escapeHtml(m.status)}</td></tr>`).join("")}</tbody></table>`;
}

function queueTable(title: string, jobs: any[]): string {
  return `<h2 style="font-size:14px;margin-top:0">${escapeHtml(title)}</h2>${jobs.length ? `<table><tbody>${jobs.map((j) => `<tr><td><span class="pill">${escapeHtml(j.status ?? "unknown")}</span></td><td class="mono">${escapeHtml(short(j.id ?? "", 18))}</td><td>${escapeHtml(short(j.window?.topic_hint ?? j.note ?? j.error ?? "", 70))}</td></tr>`).join("")}</tbody></table>` : `<div class="muted">无队列任务</div>`}`;
}

function logTable(items: unknown[]): string {
  if (!items.length) return `<div class="muted">暂无日志</div>`;
  return `<table><tbody>${items.map((item) => `<tr><td><pre>${escapeHtml(short(JSON.stringify(item, null, 2), 520))}</pre></td></tr>`).join("")}</tbody></table>`;
}

function evalTable(items: any[]): string {
  if (!items.length) return `<div class="muted">暂无本地评测结果。运行 <span class="mono">memoryops eval --core</span> 后会自动出现在这里。</div>`;
  return `<table><thead><tr><th>时间</th><th>模式</th><th>测试集</th><th>通过</th><th>详情</th></tr></thead><tbody>${items.map((item) => {
    const result = item.result ?? item.results ?? item;
    const suites = Array.isArray(result) ? result : [result];
    const total = suites.reduce((sum: number, s: any) => sum + Number(s.total ?? 0), 0);
    const passed = suites.reduce((sum: number, s: any) => sum + Number(s.passed ?? 0), 0);
    const failed = suites.reduce((sum: number, s: any) => sum + Number(s.failed ?? 0), 0);
    return `<tr><td class="mono">${escapeHtml(item.at ?? item.generated_at ?? "")}</td><td>${escapeHtml(item.mode ?? item.command ?? "eval")}</td><td>${escapeHtml(suites.map((s: any) => s.suite).filter(Boolean).join(", "))}</td><td class="${failed ? "bad" : "ok"}">${passed}/${total}</td><td><pre>${escapeHtml(short(JSON.stringify(result, null, 2), 500))}</pre></td></tr>`;
  }).join("")}</tbody></table>`;
}

function readEvalResults(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return readJsonlSafe(path);
  }
}

function readJsonlSafe(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parse_error: true, line: short(line, 200) }; }
    });
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
