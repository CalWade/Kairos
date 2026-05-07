import type { CandidateWindow } from "../../candidate/window.js";
import type { ExtractionResult } from "../decisionTypes.js";

/**
 * 从 LLM 原始响应里摘出 JSON 对象。支持裸 JSON 和 ```json 围栏。
 */
export function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const raw = fenced ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("LLM 响应不是 JSON 对象");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 把 LLM JSON 对象归一化到 ExtractionResult。每个 kind 分支填齐默认值，
 * 未知 kind 退化为 none。should_remember=false 且 kind != none 也退化为 none。
 */
export function normalizeExtractionResult(value: unknown, window: CandidateWindow): ExtractionResult {
  const input = isRecord(value) ? value : {};
  const kind = typeof input.kind === "string" ? input.kind : "none";
  const shouldRemember = typeof input.should_remember === "boolean" ? input.should_remember : kind !== "none";
  const rejectReason = optionalString(input.reject_reason);
  const base = {
    confidence: clampNumber(input.confidence, 0.3),
    evidence_message_ids: stringArray(input.evidence_message_ids, window.evidence_message_ids),
    aliases: stringArray(input.aliases, []),
    negative_keys: stringArray(input.negative_keys, []),
    reasoning: typeof input.reasoning === "string" ? input.reasoning : "LLM structured extraction",
    should_remember: shouldRemember,
    reject_reason: rejectReason,
  };

  if (!shouldRemember && kind !== "none") {
    return { kind: "none", ...base, reasoning: rejectReason ?? base.reasoning };
  }

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

// ---------- shape helpers ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
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
