import { normalizeMessage } from "./normalize.js";
import type { NormalizedMessage } from "./types.js";

export type NormalizeFeishuDocOptions = {
  docToken?: string;
  uri?: string;
  title?: string;
  baseTimestamp?: number;
};

/**
 * 将飞书文档导出的 Markdown 转成标准消息。
 *
 * 这里不把整篇文档当成一个超大输入，而是按 Markdown 标题/段落/列表切成 block。
 * 每个 block 会变成一条 NormalizedMessage，后续进入 Conversation Segmentation。
 */
export function normalizeFeishuMarkdown(markdown: string, options: NormalizeFeishuDocOptions = {}): NormalizedMessage[] {
  const blocks = splitMarkdownBlocks(markdown);
  const baseTimestamp = options.baseTimestamp ?? Date.now();
  return blocks.map((block, index) => normalizeMessage({
    text: block,
    sender: options.title ?? "feishu_doc",
    timestamp: baseTimestamp + index,
    source: "feishu_doc",
    raw: {
      docToken: options.docToken,
      uri: options.uri,
      blockIndex: index,
    },
  }));
}

export function splitMarkdownBlocks(markdown: string): string[] {
  const normalized = markdown
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, (match) => `\n${match.trim()}\n`);

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text && !isBoilerplate(text)) blocks.push(text);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    // 标题天然是边界：先 flush 前文，再单独保留标题。
    if (/^#{1,6}\s+/.test(trimmed)) {
      flush();
      current.push(trimmed);
      flush();
      continue;
    }

    // 列表项通常连续构成一个 block。若前面是普通段落，先切开。
    if (/^([-*+]\s+|\d+[.)、]\s*)/.test(trimmed)) {
      const previousIsList = current.length > 0 && /^([-*+]\s+|\d+[.)、]\s*)/.test(current[current.length - 1]?.trim() ?? "");
      if (current.length > 0 && !previousIsList) flush();
      current.push(trimmed);
      continue;
    }

    // 普通段落遇到前面的列表时，也切开。
    if (current.length > 0 && /^([-*+]\s+|\d+[.)、]\s*)/.test(current[current.length - 1]?.trim() ?? "")) {
      flush();
    }

    // 飞书标签噪声过滤。
    if (/^<\/?(text|quote-container|callout|lark-|add-ons)/.test(trimmed)) {
      continue;
    }

    current.push(trimmed);
  }
  flush();

  return blocks;
}

function isBoilerplate(text: string): boolean {
  if (!text) return true;
  if (/^<\/?[a-zA-Z-]+/.test(text)) return true;
  if (/^\*?例如[:：]/.test(text)) return true;
  if (/^\*?可以是/.test(text)) return true;
  return false;
}
