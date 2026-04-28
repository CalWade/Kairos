import type { MemoryAtom } from "./atom.js";

type RawDecision = {
  kind?: string;
  decision?: string;
  conclusion?: string;
  reasons?: string[];
  rejected_options?: Array<{ option?: string; reason?: string }>;
  opposition?: Array<{ speaker?: string; content?: string }>;
  stage?: string;
  topic?: string;
  aliases?: string[];
  negative_keys?: string[];
};

export type DecisionCard = {
  id: string;
  title: string;
  status: string;
  project?: string;
  subject: string;
  decision: string;
  conclusion?: string;
  reasons: string[];
  rejected_options: Array<{ option: string; reason: string }>;
  opposition: Array<{ speaker?: string; content: string }>;
  stage?: string;
  evidence: {
    channel: string;
    source_type: string;
    chunk_ids?: string[];
    excerpt: string;
  };
  supersedes?: string[];
  superseded_by?: string;
  review_at?: string;
};

export function buildDecisionCard(atom: MemoryAtom): DecisionCard {
  const raw = getRawDecision(atom);
  const decision = raw?.decision ?? extractLine(atom.content, "决策") ?? atom.content;
  const conclusion = raw?.conclusion ?? extractLine(atom.content, "结论");
  const reasons = normalizeStrings(raw?.reasons) ?? splitLine(extractLine(atom.content, "理由"));
  const rejected_options = normalizeRejectedOptions(raw?.rejected_options);
  const opposition = normalizeOpposition(raw?.opposition);
  return {
    id: atom.id,
    title: makeTitle(atom, raw),
    status: atom.status,
    project: atom.project,
    subject: atom.subject,
    decision,
    conclusion,
    reasons,
    rejected_options,
    opposition,
    stage: raw?.stage,
    evidence: {
      channel: atom.source.channel,
      source_type: atom.source.source_type,
      chunk_ids: atom.source.chunk_ids,
      excerpt: atom.source.excerpt,
    },
    supersedes: atom.supersedes,
    superseded_by: atom.superseded_by,
    review_at: atom.review_at,
  };
}

export function renderDecisionCardMarkdown(card: DecisionCard): string {
  const lines: string[] = [];
  lines.push(`## ${card.title}`);
  lines.push("");
  lines.push(`- 状态：${statusLabel(card.status)}`);
  if (card.project) lines.push(`- 项目：${card.project}`);
  lines.push(`- 主题：${card.subject}`);
  if (card.stage) lines.push(`- 阶段：${card.stage}`);
  if (card.review_at) lines.push(`- 复查时间：${card.review_at}`);
  if (card.superseded_by) lines.push(`- 已被替代：${card.superseded_by}`);
  if (card.supersedes?.length) lines.push(`- 替代历史：${card.supersedes.join(", ")}`);
  lines.push("");
  lines.push("### 决策");
  lines.push(card.decision);
  if (card.conclusion && card.conclusion !== card.decision) {
    lines.push("");
    lines.push("### 结论");
    lines.push(card.conclusion);
  }
  if (card.reasons.length) {
    lines.push("");
    lines.push("### 理由");
    for (const reason of card.reasons) lines.push(`- ${reason}`);
  }
  if (card.rejected_options.length) {
    lines.push("");
    lines.push("### 被否方案");
    for (const item of card.rejected_options) lines.push(`- ${item.option}：${item.reason}`);
  }
  if (card.opposition.length) {
    lines.push("");
    lines.push("### 反对 / 顾虑");
    for (const item of card.opposition) lines.push(`- ${item.speaker ? `${item.speaker}：` : ""}${item.content}`);
  }
  lines.push("");
  lines.push("### 证据");
  lines.push(`- 来源：${card.evidence.channel}/${card.evidence.source_type}`);
  if (card.evidence.chunk_ids?.length) lines.push(`- 片段：${card.evidence.chunk_ids.join(", ")}`);
  lines.push(`- 摘录：${card.evidence.excerpt}`);
  return lines.join("\n");
}


export type FeishuCardPayload = {
  config: { wide_screen_mode: boolean };
  header: {
    title: { tag: "plain_text"; content: string };
    template: "blue" | "green" | "orange" | "red" | "grey";
  };
  elements: Array<Record<string, unknown>>;
};

export function renderDecisionCardFeishuPayload(card: DecisionCard): FeishuCardPayload {
  const elements: Array<Record<string, unknown>> = [
    markdown(`**状态**：${statusLabel(card.status)}\n**主题**：${card.subject}${card.stage ? `\n**阶段**：${card.stage}` : ""}`),
    markdown(`**决策**\n${card.decision}`),
  ];
  if (card.conclusion && card.conclusion !== card.decision) elements.push(markdown(`**结论**\n${card.conclusion}`));
  if (card.reasons.length) elements.push(markdown(`**理由**\n${card.reasons.map((item) => `- ${item}`).join("\n")}`));
  if (card.rejected_options.length) {
    elements.push(markdown(`**被否方案**\n${card.rejected_options.map((item) => `- ${item.option}：${item.reason}`).join("\n")}`));
  }
  if (card.opposition.length) {
    elements.push(markdown(`**反对 / 顾虑**\n${card.opposition.map((item) => `- ${item.speaker ? `${item.speaker}：` : ""}${item.content}`).join("\n")}`));
  }
  elements.push(markdown(`**证据**\n来源：${card.evidence.channel}/${card.evidence.source_type}${card.evidence.chunk_ids?.length ? `\n片段：${card.evidence.chunk_ids.join(", ")}` : ""}\n摘录：${truncate(card.evidence.excerpt, 600)}`));
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: `Memory ID: ${card.id}` }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: card.status === "active" ? "blue" : "grey",
    },
    elements,
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function getRawDecision(atom: MemoryAtom): RawDecision | undefined {
  const raw = atom.metadata?.raw_extraction;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as RawDecision;
}

function makeTitle(atom: MemoryAtom, raw?: RawDecision): string {
  const topic = raw?.topic ?? atom.subject;
  return atom.type === "decision" ? `历史决策卡片：${topic}` : `历史记忆卡片：${topic}`;
}

function statusLabel(status: string): string {
  if (status === "active") return "当前有效";
  if (status === "superseded") return "已被替代";
  if (status === "expired") return "已过期";
  return status;
}

function extractLine(content: string, label: string): string | undefined {
  const prefix = `${label}：`;
  return content.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

function splitLine(value?: string): string[] {
  if (!value) return [];
  return value.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return result.length ? result : undefined;
}

function normalizeRejectedOptions(value: unknown): Array<{ option: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const option = (item as { option?: unknown }).option;
    const reason = (item as { reason?: unknown }).reason;
    return typeof option === "string" && typeof reason === "string" ? [{ option, reason }] : [];
  });
}

function normalizeOpposition(value: unknown): Array<{ speaker?: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const speaker = (item as { speaker?: unknown }).speaker;
    const content = (item as { content?: unknown }).content;
    if (typeof content !== "string" || !content.trim()) return [];
    return [{ speaker: typeof speaker === "string" ? speaker : undefined, content }];
  });
}
