import { collectObjectRecords, collectRecords, pickId, pickText } from "./normalize.js";

export type LarkCliExtractedText = {
  id: string;
  text: string;
  source: string;
};

export type LarkCliChatInfo = {
  chat_id: string;
  name?: string;
};

/**
 * 从 lark-cli +chat-list / +chat-search 的 JSON 输出里找目标 chat 的元数据
 * （chat_id + 可选 name）。用于 Dashboard 展示和 setup-wizard 自动补群名。
 */
export function extractChatInfoFromLarkCliJson(value: unknown, chatId: string): LarkCliChatInfo | undefined {
  const rows = collectObjectRecords(value);
  for (const row of rows) {
    const id = pickChatId(row);
    if (id !== chatId) continue;
    return { chat_id: id, name: pickChatName(row) };
  }
  return undefined;
}

/**
 * 从 lark-cli 任意 JSON 输出里提取所有"文本性"记录（去掉噪声和已知卡片格式）。
 * 用于 ingest-file / ingest-chat baseline 路径。
 */
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
