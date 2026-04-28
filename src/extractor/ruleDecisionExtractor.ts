import type { CandidateWindow } from "../candidate/window.js";
import type { ExtractionResult } from "./decisionTypes.js";

/**
 * 规则版 Decision Extractor。
 *
 * 这是 baseline：用于快速跑通结构化抽取链路和评测，不作为最终智能方案。
 * 后续可替换为 LLMDecisionExtractor，但输出 schema 保持一致。
 */
export function extractDecisionBaseline(window: CandidateWindow): ExtractionResult {
  const text = window.denoised_text;
  const evidence = window.evidence_message_ids;

  if (!window.candidate_eligible || !text.trim()) {
    return none(evidence, "候选窗口不可用或内容为空");
  }

  if (/SQLite|PostgreSQL|MongoDB|JSONL|状态库|数据库/.test(text)) {
    if (isUnresolvedQuestion(text)) {
      return none(evidence, "仅出现未定问题或待讨论表达，不能沉淀为决策记忆");
    }
    return {
      kind: "decision",
      confidence: 0.82,
      evidence_message_ids: evidence,
      topic: "local_storage_selection",
      decision: inferStorageDecision(text),
      options_considered: extractOptions(text, ["SQLite", "PostgreSQL", "MongoDB", "JSON", "JSONL"]),
      reasons: extractStorageReasons(text),
      rejected_options: extractRejectedStorageOptions(text),
      opposition: extractOpposition(text),
      conclusion: inferStorageConclusion(text),
      stage: /MVP|复赛/.test(text) ? "MVP / 复赛前" : undefined,
      aliases: ["本地存储", "数据库选型", "状态库", "Store 层", "SQLite", "PostgreSQL", "JSONL"],
      negative_keys: ["为什么不用 PostgreSQL", "为什么不用纯 JSON", "PostgreSQL 被否定原因"],
      reasoning: "命中存储/数据库选型讨论，并包含选择、理由或最终决定信号",
    };
  }

  if (/周报|Alice|Bob|发给|每周五/.test(text)) {
    const target = /Bob/i.test(text) ? "Bob" : /Alice/i.test(text) ? "Alice" : undefined;
    return {
      kind: "convention",
      confidence: 0.78,
      evidence_message_ids: evidence,
      topic: "weekly_report_receiver",
      rule: target ? `周报发给 ${target}` : "周报接收规则",
      target,
      scope: "team",
      aliases: ["周报", "周报接收人", "weekly_report_receiver", target ?? ""].filter(Boolean),
      negative_keys: target ? [`周报不是发给 ${target === "Bob" ? "Alice" : "Bob"}`] : [],
      reasoning: "命中周报接收人/团队约定信号",
    };
  }

  if (/API Key|密钥|前端直连|服务端|独立\s*ip|中文乱码|预览pdf|bug|风险|不允许/i.test(text)) {
    return {
      kind: "risk",
      confidence: 0.76,
      evidence_message_ids: evidence,
      topic: inferRiskTopic(text),
      risk: inferRisk(text),
      impact: inferRiskImpact(text),
      mitigation: inferRiskMitigation(text),
      severity: /生产环境|API Key|不允许|bug|乱码/i.test(text) ? "high" : "medium",
      review_after_days: /生产环境|API Key|风险/i.test(text) ? 3 : undefined,
      aliases: buildRiskAliases(text),
      negative_keys: ["不配置独立 IP", "预览乱码", "前端直连 API Key"],
      reasoning: "命中风险/故障/配置边界信号",
    };
  }

  if (/npm|pnpm|git|命令|测试平台|重新领|流程|引导|配置/.test(text)) {
    return {
      kind: "workflow",
      confidence: 0.7,
      evidence_message_ids: evidence,
      topic: "workflow_or_cli_steps",
      trigger: /提交前/.test(text) ? "提交前" : undefined,
      steps: extractWorkflowSteps(text),
      commands: extractCommands(text),
      expected_result: /确认|通过/.test(text) ? "流程执行后应完成确认或通过测试" : undefined,
      aliases: ["工作流", "CLI", "测试流程", "配置引导"],
      negative_keys: [],
      reasoning: "命中流程/命令/配置步骤信号",
    };
  }

  return none(evidence, "未识别出可长期复用的决策、规则、风险或工作流");
}

function isUnresolvedQuestion(text: string): boolean {
  return /[？?]|会不会|要不要|能不能|是否/.test(text)
    && /还没定|未定|再讨论|待确认|之后再说|晚上再讨论/.test(text)
    && !/最终|决定|选择|采用|使用|不使用|不允许|必须|改为|先按|同意/.test(text);
}

function none(evidence: string[], reasoning: string): ExtractionResult {
  return {
    kind: "none",
    confidence: 0.3,
    evidence_message_ids: evidence,
    aliases: [],
    negative_keys: [],
    reasoning,
  };
}

function inferStorageDecision(text: string): string {
  if (/SQLite/.test(text) && /JSONL|Event Log/.test(text)) {
    return "MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log 作为可审计事件日志";
  }
  if (/SQLite/.test(text)) return "使用 SQLite 作为本地存储方案";
  if (/PostgreSQL/.test(text)) return "使用 PostgreSQL 作为存储方案";
  return "确定本地存储方案";
}

function extractOptions(text: string, candidates: string[]): string[] {
  return candidates.filter((item) => new RegExp(item, "i").test(text));
}

function extractStorageReasons(text: string): string[] {
  const reasons: string[] = [];
  if (/demo 足够轻|本地 demo 足够轻/.test(text)) reasons.push("SQLite 本地 demo 足够轻");
  if (/查询和事务/.test(text)) reasons.push("SQLite 查询和事务比纯 JSON 更稳定");
  if (/部署成本太高|评委跑不起来/.test(text)) reasons.push("PostgreSQL 对复赛 demo 部署成本较高，可能影响评委运行");
  if (/部署链路太重/.test(text)) reasons.push("MongoDB 对本地 demo 部署链路较重");
  if (/可审计|Event Log|JSONL/.test(text)) reasons.push("JSONL Event Log 可以保留可审计事件日志");
  return reasons.length ? reasons : ["片段中提到存储方案选择及相关取舍" ];
}

function extractRejectedStorageOptions(text: string) {
  const rejected: { option: string; reason: string }[] = [];
  if (/PostgreSQL/.test(text) && /部署成本太高|评委跑不起来/.test(text)) {
    rejected.push({ option: "PostgreSQL", reason: "复赛 demo 部署成本较高，可能影响评委运行" });
  }
  if (/MongoDB/.test(text) && /不使用|部署链路太重/.test(text)) {
    rejected.push({ option: "MongoDB", reason: "本地 demo 部署链路较重" });
  }
  if (/JSON 文件|纯 JSON/.test(text) && /查询和事务/.test(text)) {
    rejected.push({ option: "纯 JSON 文件", reason: "查询和事务能力弱于 SQLite" });
  }
  return rejected;
}

function extractOpposition(text: string) {
  return text
    .split("\n")
    .filter((line) => /但是|但|不过|太高|不行|不对/.test(line))
    .map((line) => ({ content: line }));
}

function inferStorageConclusion(text: string): string {
  if (/后续.*SQLite|Store 层/.test(text)) return "后续 Store 层先按 SQLite + JSONL 实现";
  return inferStorageDecision(text);
}

function inferRiskTopic(text: string): string {
  if (/独立\s*ip|预览pdf|中文乱码|预览/i.test(text)) return "preview_independent_ip_requirement";
  if (/API Key|密钥/.test(text)) return "api_key_policy";
  return "risk_memory";
}

function inferRisk(text: string): string {
  if (/独立\s*ip|预览pdf|中文乱码|预览/i.test(text)) {
    return "预览测试需要关注独立 IP 配置，否则可能出现预览异常或 PDF 中文乱码";
  }
  if (/API Key|密钥/.test(text)) return "生产环境 API Key 不允许前端直连";
  return "片段中出现需要长期关注的风险事项";
}

function inferRiskImpact(text: string): string | undefined {
  if (/中文乱码/.test(text)) return "预览 PDF 可能出现中文乱码";
  if (/前端直连/.test(text)) return "可能造成密钥泄露或越权访问";
  return undefined;
}

function inferRiskMitigation(text: string): string | undefined {
  if (/独立\s*ip|配置.*ip|微信引导/.test(text)) return "在微信引导流程中提示用户配置独立 IP 并填入该 IP";
  if (/服务端/.test(text)) return "仅允许服务端使用生产 API Key";
  return undefined;
}

function buildRiskAliases(text: string): string[] {
  const aliases = ["风险", "故障", "配置边界"];
  if (/独立\s*ip/i.test(text)) aliases.push("独立 IP");
  if (/预览/i.test(text)) aliases.push("预览");
  if (/pdf/i.test(text)) aliases.push("PDF");
  if (/中文乱码/.test(text)) aliases.push("中文乱码");
  if (/API Key/.test(text)) aliases.push("API Key");
  return aliases;
}

function extractWorkflowSteps(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^.+?：/, "").trim())
    .filter((line) => /npm|pnpm|git|测试平台|重新领|引导|配置|提交前|必须|导出|云文档|normalize-chat-export|segment-chat-export|sender|timestamp/.test(line));
}

function extractCommands(text: string): string[] {
  const commands = text.match(/(?:npm|pnpm|git)\s+[^，。；;\n`]+/g) ?? [];
  const cliNames = text.match(/(?:normalize-chat-export|segment-chat-export|extract-decision|decision-card)/g) ?? [];
  return [...new Set([...commands, ...cliNames])];
}
