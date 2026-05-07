import type { LarkCliPurpose } from "./status.js";

export type LarkCliPlan = {
  purpose: LarkCliPurpose;
  command: string[];
  notes: string[];
};

/**
 * 按数据获取用途生成 lark-cli 命令行计划（只产出命令，不执行）。
 * 用于 CLI 里 "plan" 子命令，以及 Agent 宿主根据 purpose 规划调用。
 */
export function buildLarkCliPlan(input: {
  purpose: LarkCliPurpose;
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
    return {
      purpose: input.purpose,
      command,
      notes: [
        "需要 lark-cli 已登录并具备消息读取权限",
        "输出 JSON 后进入 Kairos normalize/extract pipeline",
      ],
    };
  }
  if (input.purpose === "message_search") {
    const command = ["lark-cli", "im", "+messages-search"];
    if (input.query) command.push("--query", input.query);
    if (input.chatId) command.push("--chat-id", input.chatId);
    command.push("--format", "json");
    if (input.profile) command.push("--profile", input.profile);
    return {
      purpose: input.purpose,
      command,
      notes: ["适合回补历史项目讨论", "搜索结果需再经过 Kairos salience 和 extractor"],
    };
  }
  if (input.purpose === "doc_fetch") {
    const command = ["lark-cli", "docs", "+fetch"];
    if (input.docUrl) command.push("--url", input.docUrl);
    command.push("--format", "json");
    if (input.profile) command.push("--profile", input.profile);
    return {
      purpose: input.purpose,
      command,
      notes: ["用于飞书文档/Wiki 内容进入 Kairos", "不要把 lark-cli 输出直接当记忆，仍需结构化抽取"],
    };
  }
  const command = ["lark-cli", "event", "consume", input.eventKey ?? "<EventKey>"];
  return {
    purpose: "event_consume",
    command,
    notes: ["用于研究官方 CLI 实时事件入口", "当前主线仍是 OpenClaw hook，lark-event 只作为候选补充"],
  };
}
