import type { MemoryAtom } from "./atom.js";
import { buildDecisionCard } from "./decisionCard.js";

export function formatRecallAnswer(query: string, memories: MemoryAtom[]): string {
  if (memories.length === 0) return "没有找到相关记忆。";
  const top = memories[0];
  const lines: string[] = [];
  lines.push(`找到 ${memories.length} 条相关记忆。`);
  lines.push("");

  if (top.type === "decision") {
    const card = buildDecisionCard(top);
    lines.push(`历史决策：${card.decision}`);
    if (card.conclusion && card.conclusion !== card.decision) lines.push(`结论：${card.conclusion}`);
    if (card.reasons.length) lines.push(`理由：${card.reasons.join("；")}`);
    if (card.rejected_options.length) {
      lines.push(`被否方案：${card.rejected_options.map((item) => `${item.option}（${item.reason}）`).join("；")}`);
    }
    lines.push(`状态：${statusLabel(top.status)}`);
    lines.push(`记忆 ID：${top.id}`);
    lines.push(`可运行：memoryops decision-card ${top.id}`);
  } else if (top.type === "risk") {
    lines.push(`风险记忆：${top.content.replace(/\n/g, "；")}`);
    if (top.review_at) lines.push(`复查时间：${top.review_at}`);
    lines.push(`状态：${statusLabel(top.status)}`);
    lines.push(`记忆 ID：${top.id}`);
  } else if (top.type === "workflow" || top.type === "cli_command") {
    lines.push(`工作流记忆：${top.content.replace(/\n/g, "；")}`);
    lines.push(`记忆 ID：${top.id}`);
  } else {
    lines.push(`相关记忆：${top.content.replace(/\n/g, "；")}`);
    lines.push(`记忆 ID：${top.id}`);
  }

  const others = memories.slice(1, 3);
  if (others.length) {
    lines.push("");
    lines.push("其他可能相关：");
    for (const item of others) {
      lines.push(`- ${item.id} / ${item.type} / ${item.subject}`);
    }
  }

  return lines.join("\n");
}

function statusLabel(status: string): string {
  if (status === "active") return "当前有效";
  if (status === "superseded") return "已被替代";
  if (status === "expired") return "已过期";
  return status;
}
