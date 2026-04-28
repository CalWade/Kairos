import type { CandidateWindow } from "../candidate/window.js";
import { chatCompletionsUrl, loadLlmConfig, type LlmConfig } from "../llm/config.js";
import type { ExtractionResult } from "./decisionTypes.js";
import { extractDecisionBaseline } from "./ruleDecisionExtractor.js";

export type LlmExtractorOptions = {
  config?: LlmConfig;
  timeoutMs?: number;
  fallback?: boolean;
};

export async function extractDecisionWithLlm(
  window: CandidateWindow,
  options: LlmExtractorOptions = {},
): Promise<ExtractionResult> {
  const config = options.config ?? loadLlmConfig();
  if (!config) {
    if (options.fallback) return extractDecisionBaseline(window);
    throw new Error("LLM 配置缺失：请设置 KAIROS_LLM_BASE_URL / KAIROS_LLM_API_KEY / KAIROS_LLM_MODEL");
  }

  try {
    const content = await callOpenAICompatible(config, buildPrompt(window), options.timeoutMs ?? 30_000);
    return normalizeExtractionResult(parseJsonObject(content), window);
  } catch (error) {
    if (options.fallback) return extractDecisionBaseline(window);
    throw error;
  }
}

async function callOpenAICompatible(config: LlmConfig, prompt: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM 请求失败：HTTP ${response.status} ${safeErrorMessage(text)}`.trim());
    }
    const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 响应缺少 message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `你是 Kairos 的企业项目决策记忆抽取器。
只返回一个 JSON 对象，不要 Markdown，不要解释。
必须严格使用以下 kind 之一：decision, convention, risk, workflow, none。
共同字段：kind, confidence, evidence_message_ids, aliases, negative_keys, reasoning。
如果只是未定问题、闲聊、状态同步，返回 kind=none。

JSON 形状：
- decision: {kind, confidence, evidence_message_ids, topic, decision, options_considered, reasons, rejected_options:[{option,reason}], opposition:[{speaker?,content}], conclusion, stage?, valid_at?, aliases, negative_keys, reasoning}
- convention: {kind, confidence, evidence_message_ids, topic, rule, owner?, target?, scope, valid_at?, aliases, negative_keys, reasoning}
- risk: {kind, confidence, evidence_message_ids, topic, risk, impact?, mitigation?, severity, review_after_days?, aliases, negative_keys, reasoning}
- workflow: {kind, confidence, evidence_message_ids, topic, trigger?, steps, commands, expected_result?, aliases, negative_keys, reasoning}
- none: {kind, confidence, evidence_message_ids, aliases, negative_keys, reasoning}`;

function buildPrompt(window: CandidateWindow): string {
  return JSON.stringify({
    task: "extract_project_memory",
    evidence_message_ids: window.evidence_message_ids,
    topic_hint: window.topic_hint,
    denoised_text: window.denoised_text,
  });
}

export function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const raw = fenced ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("LLM 响应不是 JSON 对象");
  return JSON.parse(raw.slice(start, end + 1));
}

export function normalizeExtractionResult(value: unknown, window: CandidateWindow): ExtractionResult {
  const input = isRecord(value) ? value : {};
  const kind = typeof input.kind === "string" ? input.kind : "none";
  const base = {
    confidence: clampNumber(input.confidence, 0.3),
    evidence_message_ids: stringArray(input.evidence_message_ids, window.evidence_message_ids),
    aliases: stringArray(input.aliases, []),
    negative_keys: stringArray(input.negative_keys, []),
    reasoning: typeof input.reasoning === "string" ? input.reasoning : "LLM structured extraction",
  };

  if (kind === "decision") {
    return {
      kind,
      ...base,
      topic: stringValue(input.topic, "project_decision"),
      decision: stringValue(input.decision, "识别到项目决策"),
      options_considered: stringArray(input.options_considered, []),
      reasons: stringArray(input.reasons, []),
      rejected_options: rejectedOptions(input.rejected_options),
      opposition: opposition(input.opposition),
      conclusion: stringValue(input.conclusion, stringValue(input.decision, "识别到项目决策")),
      stage: optionalString(input.stage),
      valid_at: optionalString(input.valid_at),
    };
  }
  if (kind === "convention") {
    return {
      kind,
      ...base,
      topic: stringValue(input.topic, "team_convention"),
      rule: stringValue(input.rule, "识别到团队约定"),
      owner: optionalString(input.owner),
      target: optionalString(input.target),
      scope: scopeValue(input.scope),
      valid_at: optionalString(input.valid_at),
    };
  }
  if (kind === "risk") {
    return {
      kind,
      ...base,
      topic: stringValue(input.topic, "project_risk"),
      risk: stringValue(input.risk, "识别到项目风险"),
      impact: optionalString(input.impact),
      mitigation: optionalString(input.mitigation),
      severity: severityValue(input.severity),
      review_after_days: optionalPositiveInteger(input.review_after_days),
    };
  }
  if (kind === "workflow") {
    return {
      kind,
      ...base,
      topic: stringValue(input.topic, "workflow"),
      trigger: optionalString(input.trigger),
      steps: stringArray(input.steps, []),
      commands: stringArray(input.commands, []),
      expected_result: optionalString(input.expected_result),
    };
  }
  return { kind: "none", ...base };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function rejectedOptions(value: unknown): { option: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const option = optionalString(item.option);
    const reason = optionalString(item.reason);
    return option && reason ? [{ option, reason }] : [];
  });
}

function opposition(value: unknown): { speaker?: string; content: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const content = optionalString(item.content);
    return content ? [{ speaker: optionalString(item.speaker), content }] : [];
  });
}

function scopeValue(value: unknown): "personal" | "team" | "org" {
  return value === "personal" || value === "org" ? value : "team";
}

function severityValue(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : undefined;
  return number && Number.isInteger(number) && number > 0 ? number : undefined;
}

function clampNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : fallback;
  return Math.max(0, Math.min(1, number));
}

function safeErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message?.slice(0, 200) ?? "";
  } catch {
    return text.slice(0, 120);
  }
}
