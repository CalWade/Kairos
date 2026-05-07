import type { NormalizedMessage } from "../candidate/types.js";
import { isLarkCliNoiseRecord } from "./noise.js";

/**
 * 把 lark-cli JSON 输出转换为 NormalizedMessage[]。
 * 保留完整元数据（sender, timestamp, chat_id, thread_id, reply_to），
 * 供后续线程恢复、证据链、去重使用。
 * 被调用方主要是 CLI ingest-chat 和 larkRuntime worker。
 */
export function toNormalizedMessages(value: unknown, chatIdHint?: string): NormalizedMessage[] {
  const rows = collectRecords(value);
  const result: NormalizedMessage[] = [];
  for (const row of rows) {
    const rawText = pickText(row);
    if (!rawText) continue;
    const id = pickId(row) ?? `lark_${row._index ?? result.length}`;
    const timestamp = pickTimestamp(row);
    const chat_id = typeof row.chat_id === "string" ? row.chat_id : chatIdHint;
    const thread_id = typeof row.thread_id === "string" ? row.thread_id : undefined;
    const reply_to = typeof row.reply_to === "string" ? row.reply_to : undefined;
    // 优先使用文本前缀里的角色名【xxx】；fallback 到 API 返回的 sender。
    // 用于多 webhook 机器人共用同一 app_id 时的角色区分。
    const { role, body } = stripRolePrefix(rawText);
    const sender = role ?? pickSender(row);
    result.push({
      id,
      sender,
      text: body,
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

/**
 * 解析消息正文里的【角色】前缀，用于多 webhook 机器人共用同一 app_id
 * 的场景（飞书自定义机器人 webhook 全部以同一 app_id 送达 lark-cli）。
 * 支持全角/半角括号；role 限制 1-12 字符，避免把普通"【注意】"之类正文前缀误吃。
 */
export function stripRolePrefix(text: string): { role?: string; body: string } {
  const match = text.match(/^\s*(?:【([^【】]{1,12})】|\[([^\[\]]{1,12})\])\s*/u);
  if (!match) return { body: text };
  const role = (match[1] ?? match[2] ?? "").trim();
  if (!role) return { body: text };
  return { role, body: text.slice(match[0].length) };
}

// ---------- 公共 picker（下层给 chatInfo.ts 用） ----------

/**
 * 从 LarkCli 原始 JSON 里收集所有"像记录"的对象（深度优先遍历常见容器 key）。
 * 调用方可用 picker* 系列从里面提取具体字段。
 */
export function collectObjectRecords(value: unknown): Record<string, unknown>[] {
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

/**
 * collectObjectRecords + 过滤掉没有可读文本的记录。
 * 典型用法：toNormalizedMessages / extractTextsFromLarkCliJson。
 */
export function collectRecords(value: unknown): Record<string, unknown>[] {
  return collectObjectRecords(value).filter((record) => !!pickText(record));
}

/**
 * 从记录里挑正文文本。优先直接的 text/content/body/markdown，
 * 再试嵌套 content.{text,content,title}；自动 strip 外层 JSON 包装；
 * 命中 isLarkCliNoiseRecord 返回 undefined。
 */
export function pickText(record: Record<string, unknown>): string | undefined {
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

export function pickId(record: Record<string, unknown>): string | undefined {
  for (const key of ["message_id", "id", "msg_id", "item_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

// ---------- 下面是 toNormalizedMessages 内部 picker ----------

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

function stripJsonText(value: string): string {
  try {
    const parsed = JSON.parse(value) as { text?: unknown; content?: unknown };
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
  } catch {}
  return value;
}
