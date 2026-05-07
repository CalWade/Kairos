import type { CandidateWindow } from "../../candidate/window.js";
import { LLM_EXTRACTOR_PROMPT_VERSION } from "./types.js";

export const SYSTEM_PROMPT = `Kairos 企业项目决策记忆抽取器。仅输出单个 JSON 对象（无 Markdown）。

kind ∈ {decision, convention, risk, workflow, none}
判定优先级：risk > decision > convention > workflow > none
- risk：安全/密钥/泄露/生产风险/上线隐患/稳定性告警
- decision：方案取舍、技术选型、采用/否决，必须有结论
- convention：团队约定、负责人/接收人、周期规则、命名
- workflow：可复用操作步骤或命令序列
- none：未定问题、复议、闲聊、状态同步、噪声
只基于 evidence_message_ids 文本抽取，不补充未出现的信息。should_remember=false 必须给 reject_reason。

公共字段：kind, should_remember, reject_reason?, confidence, evidence_message_ids, aliases, negative_keys, reasoning
专属字段：
- decision +{topic, decision, options_considered, reasons, rejected_options:[{option,reason}], opposition:[{speaker?,content}], conclusion, stage?, valid_at?}
- convention +{topic, rule, owner?, target?, scope, valid_at?}
- risk +{topic, risk, impact?, mitigation?, severity, review_after_days?}
- workflow +{topic, trigger?, steps, commands, expected_result?}`;

export function buildPrompt(window: CandidateWindow, options: { maxInputChars: number }): string {
  const truncated = window.denoised_text.length > options.maxInputChars;
  return JSON.stringify({
    task: "extract_project_memory",
    prompt_version: LLM_EXTRACTOR_PROMPT_VERSION,
    evidence_message_ids: window.evidence_message_ids,
    topic_hint: window.topic_hint,
    truncated,
    denoised_text: truncated ? `${window.denoised_text.slice(0, options.maxInputChars)}
[已截断]` : window.denoised_text,
  });
}
