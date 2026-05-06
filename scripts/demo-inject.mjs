#!/usr/bin/env node
// Kairos demo 消息注入脚本
// 读取 examples/demo-scripts/*.jsonl，按顺序通过多 webhook 发送到目标群

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DEFAULT_SCRIPTS_DIR = join(ROOT, "examples", "demo-scripts");
const DEFAULT_WEBHOOKS_PATH = join(ROOT, "data", "demo-webhooks.json");

function listScripts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, extname(f)))
    .sort();
}

function resolveScriptPath(nameOrPath, dir) {
  if (nameOrPath.endsWith(".jsonl") || nameOrPath.includes("/")) {
    return resolve(nameOrPath);
  }
  return join(dir, `${nameOrPath}.jsonl`);
}

function loadScript(path) {
  if (!existsSync(path)) throw new Error(`剧本不存在: ${path}`);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line, i) => {
    try {
      const msg = JSON.parse(line);
      if (!msg.role || typeof msg.role !== "string") throw new Error("缺 role");
      if (!msg.text || typeof msg.text !== "string") throw new Error("缺 text");
      return { role: msg.role, text: msg.text, pause_ms: Number(msg.pause_ms ?? 1500) };
    } catch (error) {
      throw new Error(`剧本第 ${i + 1} 行解析失败: ${error.message}`);
    }
  });
}

function loadWebhooks(path) {
  if (!existsSync(path)) {
    throw new Error(
      `缺 webhook 映射文件: ${path}\n` +
      `请新建：\n` +
      `{\n  "roles": {\n    "product": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",\n    "engA": "https://open.feishu.cn/open-apis/bot/v2/hook/yyy"\n  }\n}`
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const roles = raw.roles ?? raw;
  if (!roles || typeof roles !== "object") throw new Error(`${path} 结构错误：期望 { roles: { name: url } }`);
  const cleaned = {};
  for (const [role, url] of Object.entries(roles)) {
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`role=${role} 的 webhook 不是合法 https URL`);
    }
    cleaned[role] = url;
  }
  return cleaned;
}

function redactWebhook(url) {
  const m = url.match(/\/hook\/([^/?]+)/);
  if (!m) return "<webhook>";
  const id = m[1];
  return `${url.slice(0, m.index + 6)}${id.slice(0, 4)}…${id.slice(-4)}`;
}

async function sendTextMessage(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  const ok = response.ok && (payload.code === 0 || payload.StatusCode === 0 || typeof payload.code === "undefined");
  return { ok, status: response.status, code: payload.code, msg: payload.msg ?? payload.Message, raw };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Kairos demo 消息注入脚本

用法：
  node scripts/demo-inject.mjs --list
  node scripts/demo-inject.mjs --script <name|path> [--dry-run] [--webhooks <path>] [--scripts-dir <path>]
      [--min-pause-ms <ms>] [--start <index>] [--end <index>]

选项：
  --list                列出 examples/demo-scripts/ 下所有可用剧本
  --script <name|path>  剧本名（不带 .jsonl）或完整路径
  --dry-run             只打印顺序和 webhook 映射，不真发
  --webhooks <path>     webhook 映射 JSON；默认 data/demo-webhooks.json
  --scripts-dir <path>  剧本目录；默认 examples/demo-scripts
  --min-pause-ms <ms>   最短等待时间下限，避免 pause_ms=0 刷屏；默认 400
  --start <index>       从第 N 条开始（1-based）
  --end <index>         到第 N 条结束（含）
  --help                显示本说明
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: "boolean", default: false },
      script: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      webhooks: { type: "string", default: DEFAULT_WEBHOOKS_PATH },
      "scripts-dir": { type: "string", default: DEFAULT_SCRIPTS_DIR },
      "min-pause-ms": { type: "string", default: "400" },
      start: { type: "string" },
      end: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help || (!values.list && !values.script)) {
    printHelp();
    if (!values.help) process.exitCode = 1;
    return;
  }

  const scriptsDir = values["scripts-dir"];

  if (values.list) {
    const scripts = listScripts(scriptsDir);
    console.log(JSON.stringify({ ok: true, scripts_dir: scriptsDir, scripts }, null, 2));
    return;
  }

  const scriptPath = resolveScriptPath(values.script, scriptsDir);
  const messages = loadScript(scriptPath);
  const webhooks = loadWebhooks(values.webhooks);
  const minPauseMs = Number(values["min-pause-ms"]);
  const start = values.start ? Number(values.start) : 1;
  const end = values.end ? Number(values.end) : messages.length;

  const slice = messages.slice(start - 1, end);
  const missingRoles = [...new Set(slice.map((m) => m.role))].filter((r) => !webhooks[r]);
  if (missingRoles.length) {
    throw new Error(`剧本用到但未配置 webhook 的角色: ${missingRoles.join(", ")}`);
  }

  if (values["dry-run"]) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      script: scriptPath,
      webhooks_path: values.webhooks,
      roles: Object.fromEntries(Object.entries(webhooks).map(([k, v]) => [k, redactWebhook(v)])),
      total: slice.length,
      preview: slice.map((m, i) => ({ index: start + i, role: m.role, text: m.text, pause_ms: m.pause_ms })),
    }, null, 2));
    return;
  }

  const results = [];
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const idx = start + i;
    const webhook = webhooks[m.role];
    process.stderr.write(`[${idx}/${end}] ${m.role} → ${m.text.slice(0, 40)}${m.text.length > 40 ? "…" : ""}\n`);
    try {
      const result = await sendTextMessage(webhook, m.text);
      results.push({ index: idx, role: m.role, ok: result.ok, status: result.status, code: result.code, msg: result.msg });
      if (!result.ok) {
        process.stderr.write(`  ! webhook 返回非成功：${JSON.stringify({ status: result.status, code: result.code, msg: result.msg })}\n`);
      }
    } catch (error) {
      results.push({ index: idx, role: m.role, ok: false, error: error.message });
      process.stderr.write(`  ! fetch 失败：${error.message}\n`);
    }
    const wait = Math.max(minPauseMs, m.pause_ms ?? 1500);
    if (i < slice.length - 1) await sleep(wait);
  }

  const summary = {
    ok: results.every((r) => r.ok),
    script: scriptPath,
    total: results.length,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
