import { spawnSync } from "node:child_process";

export type LarkCliStatus = {
  installed: boolean;
  version?: string;
  auth_checked: boolean;
  auth_ok?: boolean;
  auth_summary?: string;
  error?: string;
};

export type LarkCliPlan = {
  purpose: "chat_messages" | "message_search" | "doc_fetch" | "event_consume";
  command: string[];
  notes: string[];
};

export function checkLarkCliStatus(options: { checkAuth?: boolean; profile?: string } = {}): LarkCliStatus {
  const version = spawnSync("lark-cli", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.error || version.status !== 0) {
    return {
      installed: false,
      auth_checked: false,
      error: version.error ? String(version.error) : (version.stderr || "lark-cli not found").trim(),
    };
  }

  const status: LarkCliStatus = {
    installed: true,
    version: (version.stdout || version.stderr).trim(),
    auth_checked: false,
  };

  if (!options.checkAuth) return status;

  const authArgs = ["auth", "status", ...(options.profile ? ["--profile", options.profile] : [])];
  const auth = spawnSync("lark-cli", authArgs, { encoding: "utf8", timeout: 15_000 });
  status.auth_checked = true;
  status.auth_ok = auth.status === 0 && !/not logged|未登录|no credential|no auth/i.test(`${auth.stdout}\n${auth.stderr}`);
  status.auth_summary = (auth.stdout || auth.stderr || "").trim();
  return status;
}

export function buildLarkCliPlan(input: {
  purpose: LarkCliPlan["purpose"];
  chatId?: string;
  query?: string;
  docUrl?: string;
  eventKey?: string;
  since?: string;
  until?: string;
  profile?: string;
}): LarkCliPlan {
  if (input.purpose === "chat_messages") {
    const command = ["lark-cli", "im", "+chat-messages-list"];
    if (input.chatId) command.push("--chat-id", input.chatId);
    if (input.since) command.push("--start-time", input.since);
    if (input.until) command.push("--end-time", input.until);
    command.push("--format", "json");
    if (input.profile) command.push("--profile", input.profile);
    return { purpose: input.purpose, command, notes: ["需要 lark-cli 已登录并具备消息读取权限", "输出 JSON 后进入 Kairos normalize/extract pipeline"] };
  }
  if (input.purpose === "message_search") {
    const command = ["lark-cli", "im", "+messages-search"];
    if (input.query) command.push("--query", input.query);
    if (input.chatId) command.push("--chat-id", input.chatId);
    command.push("--format", "json");
    if (input.profile) command.push("--profile", input.profile);
    return { purpose: input.purpose, command, notes: ["适合回补历史项目讨论", "搜索结果需再经过 Kairos salience 和 extractor"] };
  }
  if (input.purpose === "doc_fetch") {
    const command = ["lark-cli", "docs", "+fetch"];
    if (input.docUrl) command.push("--url", input.docUrl);
    command.push("--format", "json");
    if (input.profile) command.push("--profile", input.profile);
    return { purpose: input.purpose, command, notes: ["用于飞书文档/Wiki 内容进入 Kairos", "不要把 lark-cli 输出直接当记忆，仍需结构化抽取"] };
  }
  const command = ["lark-cli", "event", "consume", input.eventKey ?? "<EventKey>"];
  return { purpose: "event_consume", command, notes: ["用于研究官方 CLI 实时事件入口", "当前主线仍是 OpenClaw hook，lark-event 只作为候选补充"] };
}


export type LarkCliPurpose = LarkCliPlan["purpose"];

const REQUIRED_SCOPES: Record<LarkCliPurpose, string[]> = {
  chat_messages: ["im:message.group_msg:get_as_user"],
  message_search: ["search:message"],
  doc_fetch: ["docs:document.content:read"],
  event_consume: [],
};

export type LarkCliPreflight = {
  purpose: LarkCliPurpose;
  installed: boolean;
  auth_ok: boolean;
  granted_scopes: string[];
  required_scopes: string[];
  missing_scopes: string[];
  recommended_command?: string[];
  notes: string[];
};

export function preflightLarkCliPurpose(purpose: LarkCliPurpose, options: { profile?: string } = {}): LarkCliPreflight {
  const status = checkLarkCliStatus({ checkAuth: true, profile: options.profile });
  const granted = parseGrantedScopes(status.auth_summary ?? "");
  const required = REQUIRED_SCOPES[purpose];
  const missing = required.filter((scope) => !granted.includes(scope));
  return {
    purpose,
    installed: status.installed,
    auth_ok: !!status.auth_ok,
    granted_scopes: granted,
    required_scopes: required,
    missing_scopes: missing,
    recommended_command: missing.length ? ["lark-cli", "auth", "login", "--scope", missing.join(" "), ...(options.profile ? ["--profile", options.profile] : [])] : undefined,
    notes: buildPreflightNotes(purpose, status.installed, !!status.auth_ok, missing),
  };
}

function parseGrantedScopes(authSummary: string): string[] {
  try {
    const parsed = JSON.parse(authSummary) as { scope?: unknown };
    if (typeof parsed.scope === "string") return parsed.scope.split(/\s+/).filter(Boolean);
  } catch {}
  const match = authSummary.match(/"scope"\s*:\s*"([^"]+)"/);
  if (match) return match[1].split(/\s+/).filter(Boolean);
  return [];
}

function buildPreflightNotes(purpose: LarkCliPurpose, installed: boolean, authOk: boolean, missing: string[]): string[] {
  if (!installed) return ["本机未安装 lark-cli：npm install -g @larksuite/cli"];
  if (!authOk) return ["lark-cli 未完成有效授权：先运行 lark-cli config init --new 和 lark-cli auth login --recommend"];
  if (missing.length) return [
    `当前授权缺少 ${missing.join(", ")}`,
    "如果租户/应用不允许授予该 scope，可改用飞书导出文件或 OpenClaw 飞书工具作为数据来源。",
  ];
  return [`${purpose} 所需 lark-cli scope 已满足`];
}

import type { NormalizedMessage } from "./candidate/types.js";

export type LarkCliExtractedText = {
  id: string;
  text: string;
  source: string;
};

export type LarkCliChatInfo = {
  chat_id: string;
  name?: string;
};

export function extractChatInfoFromLarkCliJson(value: unknown, chatId: string): LarkCliChatInfo | undefined {
  const rows = collectObjectRecords(value);
  for (const row of rows) {
    const id = pickChatId(row);
    if (id !== chatId) continue;
    return { chat_id: id, name: pickChatName(row) };
  }
  return undefined;
}

export function extractTextsFromLarkCliJson(value: unknown): LarkCliExtractedText[] {
  const rows = collectRecords(value);
  const result: LarkCliExtractedText[] = [];
  let index = 0;
  for (const row of rows) {
    const text = pickText(row);
    if (!text) continue;
    result.push({
      id: pickId(row) ?? `lark_${index++}`,
      text,
      source: pickSource(row),
    });
  }
  return dedupeByText(result);
}

/**
 * 将 lark-cli JSON 输出转换为 NormalizedMessage。
 * 保留完整元数据（sender, timestamp, chat_id, thread_id, reply_to），
 * 供后续线程恢复、证据链、去重使用。
 */
export function toNormalizedMessages(value: unknown, chatIdHint?: string): NormalizedMessage[] {
  const rows = collectRecords(value);
  const result: NormalizedMessage[] = [];
  for (const row of rows) {
    const text = pickText(row);
    if (!text) continue;
    const id = pickId(row) ?? `lark_${row._index ?? result.length}`;
    const sender = pickSender(row);
    const timestamp = pickTimestamp(row);
    const chat_id = typeof row.chat_id === "string" ? row.chat_id : chatIdHint;
    const thread_id = typeof row.thread_id === "string" ? row.thread_id : undefined;
    const reply_to = typeof row.reply_to === "string" ? row.reply_to : undefined;
    result.push({
      id,
      sender,
      text,
      timestamp,
      chat_id,
      thread_id,
      reply_to,
      mentions: pickMentions(row),
      links: pickLinks(row),
      doc_tokens: [],
      task_ids: [],
      source: "feishu_chat",
      raw: row,
    });
  }
  return dedupeById(result);
}

function pickSender(record: Record<string, unknown>): string {
  const sender = record.sender;
  if (sender && typeof sender === "object") {
    const s = sender as Record<string, unknown>;
    if (typeof s.name === "string") return s.name;
    if (typeof s.id === "string") return s.id;
    if (typeof s.open_id === "string") return s.open_id;
  }
  return typeof record.sender_id === "string" ? record.sender_id : "unknown";
}

function pickTimestamp(record: Record<string, unknown>): number {
  const ts = record.create_time ?? record.timestamp ?? record.send_time;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function pickMentions(record: Record<string, unknown>): string[] {
  const mentions = record.mentions ?? record.at_users;
  if (!Array.isArray(mentions)) return [];
  return mentions
    .map((m) => {
      if (typeof m === "string") return m;
      const obj = m as Record<string, unknown>;
      return (typeof obj.name === "string" ? obj.name : undefined) ?? (typeof obj.id === "string" ? obj.id : undefined) ?? "";
    })
    .filter(Boolean);
}

function pickLinks(record: Record<string, unknown>): string[] {
  const text = String(record.text ?? record.content ?? "");
  const links: string[] = [];
  const urlRe = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) links.push(m[0]);
  return links;
}

function dedupeById(items: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function collectRecords(value: unknown): Record<string, unknown>[] {
  return collectObjectRecords(value).filter((record) => !!pickText(record));
}

function collectObjectRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    result.push(record);
    for (const key of ["items", "messages", "chats", "data", "results", "list"]) {
      if (key in record) visit(record[key]);
    }
  };
  visit(value);
  return result;
}

function pickChatId(record: Record<string, unknown>): string | undefined {
  for (const key of ["chat_id", "chatId", "id", "open_chat_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.startsWith("oc_")) return value;
  }
  return undefined;
}

function pickChatName(record: Record<string, unknown>): string | undefined {
  for (const key of ["name", "chat_name", "chatName", "title", "topic"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const chat = record.chat;
  if (chat && typeof chat === "object") return pickChatName(chat as Record<string, unknown>);
  return undefined;
}

function pickText(record: Record<string, unknown>): string | undefined {
  if (isLarkCliNoiseRecord(record)) return undefined;
  for (const key of ["text", "content", "body", "markdown", "plain_text", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return stripJsonText(value.trim());
  }
  const content = record.content;
  if (content && typeof content === "object") {
    const nested = content as Record<string, unknown>;
    for (const key of ["text", "content", "title"]) {
      const value = nested[key];
      if (typeof value === "string" && value.trim()) return stripJsonText(value.trim());
    }
  }
  return undefined;
}

function isLarkCliNoiseRecord(record: Record<string, unknown>): boolean {
  const sender = record.sender;
  if (sender && typeof sender === "object" && (sender as Record<string, unknown>).sender_type === "app") return true;
  if (record.msg_type === "interactive" || record.msg_type === "post") return true;
  const raw = String(record.content ?? record.text ?? "").trim();
  if (raw.startsWith("<card>") || raw.includes("open.feishu.cn/page/cli") || raw.includes("accounts.feishu.cn/oauth")) return true;
  return false;
}

function stripJsonText(value: string): string {
  try {
    const parsed = JSON.parse(value) as { text?: unknown; content?: unknown };
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
  } catch {}
  return value;
}

function pickId(record: Record<string, unknown>): string | undefined {
  for (const key of ["message_id", "id", "msg_id", "item_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function pickSource(record: Record<string, unknown>): string {
  const chat = typeof record.chat_id === "string" ? record.chat_id : undefined;
  const sender = typeof record.sender === "string" ? record.sender : undefined;
  return [chat, sender].filter(Boolean).join("/") || "lark-cli";
}

function dedupeByText(items: LarkCliExtractedText[]): LarkCliExtractedText[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export function runLarkCliJson(args: string[]): unknown {
  const result = spawnSync("lark-cli", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `lark-cli failed with status ${result.status}`).trim());
  }
  return JSON.parse(result.stdout);
}

export function runLarkCliText(args: string[], options: { timeoutMs?: number } = {}): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("lark-cli", args, { encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}
