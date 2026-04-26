import type { CandidateFact, MemoryAtom, MemoryType, ReconcileDecision } from "../memory/atom.js";
import { createManualMemory } from "../memory/factory.js";

export function extractFacts(text: string, options: { project?: string } = {}): CandidateFact[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const type = inferType(normalized);
  return [{
    fact: normalized,
    type,
    scope: "team",
    project: options.project,
    layer: inferLayer(type),
    formation: "explicit",
    subject: inferSubject(normalized, type),
    confidence: 0.72,
    importance: inferImportance(type),
    reasoning: "mock extractor: 基于关键词和显式表达抽取候选事实",
  }];
}

export function reconcileFact(fact: CandidateFact, existing: MemoryAtom[]): ReconcileDecision {
  if (existing.length === 0) {
    return { action: "ADD", reasoning: "没有相似旧记忆，作为新记忆添加" };
  }
  const target = existing[0];
  const relation = inferRelation(fact.fact, target.content);
  if (relation === "DIRECT_CONFLICT" || relation === "TEMPORAL_SEQUENCE" || relation === "INDIRECT_INVALIDATION") {
    return {
      action: "SUPERSEDE",
      target_id: target.id,
      merged_content: fact.fact,
      relation,
      reasoning: `新事实与旧记忆存在 ${relation}，应非损失效覆盖旧记忆`,
    };
  }
  if (target.content.includes(fact.fact) || fact.fact.includes(target.content)) {
    return { action: "DUPLICATE", target_id: target.id, reasoning: "新事实与旧记忆重复" };
  }
  return { action: "ADD", reasoning: "未发现明确冲突，作为补充记忆添加" };
}

export function createAtomFromFact(fact: CandidateFact) {
  return createManualMemory({
    text: fact.fact,
    project: fact.project,
    type: fact.type,
    scope: fact.scope,
    layer: fact.layer,
    formation: fact.formation,
    subject: fact.subject,
    importance: fact.importance,
    confidence: fact.confidence,
    tags: [fact.type, fact.subject].filter(Boolean),
  });
}

function inferType(text: string): MemoryType {
  if (/决定|最终|选择|采用|不使用|不用|方案/.test(text)) return "decision";
  if (/以后|每周|周报|固定|约定|规则|发给/.test(text)) return "convention";
  if (/风险|禁止|不允许|API Key|密钥|生产环境/.test(text)) return "risk";
  if (/截止|DDL|提交|到期|deadline/i.test(text)) return "deadline";
  if (/命令|npm|pnpm|git|部署|运行/.test(text)) return "cli_command";
  return "knowledge";
}

function inferLayer(type: MemoryType) {
  if (type === "cli_command") return "behavior" as const;
  if (["decision", "convention", "risk", "deadline"].includes(type)) return "rule" as const;
  return "knowledge" as const;
}

function inferImportance(type: MemoryType): 1 | 2 | 3 | 4 | 5 {
  if (type === "risk") return 5;
  if (["decision", "deadline"].includes(type)) return 4;
  if (["convention", "workflow"].includes(type)) return 3;
  return 2;
}

function inferSubject(text: string, type: MemoryType): string {
  if (/周报/.test(text) && /发给/.test(text)) return "weekly_report_receiver";
  if (/PostgreSQL|MongoDB|数据库/.test(text)) return "database_selection";
  if (/API Key|密钥/.test(text)) return "api_key_policy";
  if (/复赛|提交|Demo|录屏/.test(text)) return "competition_submission";
  if (type === "cli_command") return "cli_workflow";
  return text.replace(/\s+/g, " ").slice(0, 40);
}

function inferRelation(newText: string, oldText: string) {
  if (/不对|改为|改成|以后/.test(newText)) return "DIRECT_CONFLICT" as const;
  if (/不再|离职|取消|废弃/.test(newText)) return "INDIRECT_INVALIDATION" as const;
  if (/之前|之后|从.*开始|到.*为止/.test(newText)) return "TEMPORAL_SEQUENCE" as const;
  return oldText === newText ? "COMPLEMENT" as const : "INDEPENDENT" as const;
}
