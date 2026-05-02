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

export function checkLarkCliStatus(options: { checkAuth?: boolean } = {}): LarkCliStatus {
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

  const auth = spawnSync("lark-cli", ["auth", "status"], { encoding: "utf8", timeout: 15_000 });
  status.auth_checked = true;
  status.auth_ok = auth.status === 0 && !/not logged|未登录|no credential|no auth/i.test(`${auth.stdout}\n${auth.stderr}`);
  status.auth_summary = (auth.stdout || auth.stderr || "").trim().slice(0, 1000);
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
}): LarkCliPlan {
  if (input.purpose === "chat_messages") {
    const command = ["lark-cli", "im", "+chat-messages-list"];
    if (input.chatId) command.push("--chat-id", input.chatId);
    if (input.since) command.push("--start-time", input.since);
    if (input.until) command.push("--end-time", input.until);
    command.push("--format", "json");
    return { purpose: input.purpose, command, notes: ["需要 lark-cli 已登录并具备消息读取权限", "输出 JSON 后进入 Kairos normalize/extract pipeline"] };
  }
  if (input.purpose === "message_search") {
    const command = ["lark-cli", "im", "+messages-search"];
    if (input.query) command.push("--query", input.query);
    if (input.chatId) command.push("--chat-id", input.chatId);
    command.push("--format", "json");
    return { purpose: input.purpose, command, notes: ["适合回补历史项目讨论", "搜索结果需再经过 Kairos salience 和 extractor"] };
  }
  if (input.purpose === "doc_fetch") {
    const command = ["lark-cli", "docs", "+fetch"];
    if (input.docUrl) command.push("--url", input.docUrl);
    command.push("--format", "json");
    return { purpose: input.purpose, command, notes: ["用于飞书文档/Wiki 内容进入 Kairos", "不要把 lark-cli 输出直接当记忆，仍需结构化抽取"] };
  }
  const command = ["lark-cli", "event", "consume", input.eventKey ?? "<EventKey>"];
  return { purpose: "event_consume", command, notes: ["用于研究官方 CLI 实时事件入口", "当前主线仍是 OpenClaw hook，lark-event 只作为候选补充"] };
}


export type LarkCliExtractedText = {
  id: string;
  text: string;
  source: string;
};

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

function collectRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (pickText(record)) result.push(record);
    for (const key of ["items", "messages", "data", "results", "list"]) {
      if (key in record) visit(record[key]);
    }
  };
  visit(value);
  return result;
}

function pickText(record: Record<string, unknown>): string | undefined {
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
