import type { CandidateWindow } from "../candidate/window.js";
import { chatCompletionsUrl, loadLlmConfig, type LlmConfig } from "../llm/config.js";
import type { ExtractionResult } from "./decisionTypes.js";
import { extractDecisionBaseline } from "./ruleDecisionExtractor.js";

export const LLM_EXTRACTOR_PROMPT_VERSION = "llm-extractor-v0.2";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_INPUT_CHARS = 3_000;

type FetchLike = typeof fetch;

export type LlmExtractorOptions = {
  config?: LlmConfig;
  timeoutMs?: number;
  fallback?: boolean;
  maxAttempts?: number;
  maxInputChars?: number;
  fetchImpl?: FetchLike;
};

type LlmFailureReason = "missing_config" | "timeout" | "http_error" | "parse_error" | "empty_response" | "network_error" | "unknown";

type LlmAttemptFailure = {
  attempt: number;
  reason: LlmFailureReason;
  detail: string;
};

type LlmCallResult =
  | { ok: true; content: string; attempts: number }
  | { ok: false; failures: LlmAttemptFailure[] };

export async function extractDecisionWithLlm(
  window: CandidateWindow,
  options: LlmExtractorOptions = {},
): Promise<ExtractionResult> {
  const config = options.config ?? loadLlmConfig();
  if (!config) {
    if (options.fallback) return degradedFallback(window, [{ attempt: 0, reason: "missing_config", detail: "LLM 配置缺失" }]);
    throw new Error("LLM 配置缺失：请设置 KAIROS_LLM_BASE_URL / KAIROS_LLM_API_KEY / KAIROS_LLM_MODEL");
  }

  const prompt = buildPrompt(window, { maxInputChars: options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS });
  const call = await callOpenAICompatibleWithRetry(config, prompt, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    fetchImpl: options.fetchImpl ?? fetch,
  });

  if (call.ok) {
    try {
      const normalized = normalizeExtractionResult(parseJsonObject(call.content), window);
      return withMetadata(normalized, {
        extractor: "llm",
        prompt_version: LLM_EXTRACTOR_PROMPT_VERSION,
        attempts: call.attempts,
        truncated: window.denoised_text.length > (options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS),
      });
    } catch (error) {
      const failure = [{ attempt: call.attempts, reason: "parse_error" as const, detail: errorMessage(error) }];
      if (options.fallback) return degradedFallback(window, failure);
      throw new Error(`LLM JSON 解析失败：${errorMessage(error)}`);
    }
  }

  if (options.fallback) return degradedFallback(window, call.failures);
  const last = call.failures.at(-1);
  throw new Error(`LLM 抽取失败：${last?.reason ?? "unknown"} ${last?.detail ?? ""}`.trim());
}

async function callOpenAICompatibleWithRetry(
  config: LlmConfig,
  prompt: string,
  options: { timeoutMs: number; maxAttempts: number; fetchImpl: FetchLike },
): Promise<LlmCallResult> {
  const failures: LlmAttemptFailure[] = [];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const content = await callOpenAICompatible(config, prompt, options.timeoutMs, options.fetchImpl);
      // Treat invalid JSON as a retryable LLM output failure, not as a final success.
      parseJsonObject(content);
      return { ok: true, content, attempts: attempt };
    } catch (error) {
      failures.push({ attempt, ...classifyLlmError(error) });
    }
  }
  return { ok: false, failures };
}

async function callOpenAICompatible(config: LlmConfig, prompt: string, timeoutMs: number, fetchImpl: FetchLike): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
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
      throw new LlmHttpError(`HTTP ${response.status} ${safeErrorMessage(text)}`.trim());
    }
    let payload: { choices?: Array<{ message?: { content?: string } }> };
    try {
      payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    } catch (error) {
      throw new LlmParseError(`响应体不是 JSON：${errorMessage(error)}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new LlmEmptyResponseError("LLM 响应缺少 message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `你是 Kairos 的企业项目决策记忆抽取器。
只返回一个 JSON 对象，不要 Markdown，不要解释。
必须严格使用以下 kind 之一：decision, convention, risk, workflow, none。
共同字段：kind, should_remember, reject_reason, confidence, evidence_message_ids, aliases, negative_keys, reasoning。
如果只是未定问题、复议问题、闲聊、状态同步、噪声消息，返回 kind=none 且 should_remember=false，并写 reject_reason。
只能基于 evidence_message_ids 对应文本抽取，不得补充未出现的信息。

JSON 形状：
- decision: {kind, should_remember, reject_reason?, confidence, evidence_message_ids, topic, decision, options_considered, reasons, rejected_options:[{option,reason}], opposition:[{speaker?,content}], conclusion, stage?, valid_at?, aliases, negative_keys, reasoning}
- convention: {kind, should_remember, reject_reason?, confidence, evidence_message_ids, topic, rule, owner?, target?, scope, valid_at?, aliases, negative_keys, reasoning}
- risk: {kind, should_remember, reject_reason?, confidence, evidence_message_ids, topic, risk, impact?, mitigation?, severity, review_after_days?, aliases, negative_keys, reasoning}
- workflow: {kind, should_remember, reject_reason?, confidence, evidence_message_ids, topic, trigger?, steps, commands, expected_result?, aliases, negative_keys, reasoning}
- none: {kind, should_remember:false, reject_reason, confidence, evidence_message_ids, aliases, negative_keys, reasoning}`;

function buildPrompt(window: CandidateWindow, options: { maxInputChars: number }): string {
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

function degradedFallback(window: CandidateWindow, failures: LlmAttemptFailure[]): ExtractionResult {
  const fallback = extractDecisionBaseline(window);
  return withMetadata(fallback, {
    extractor: "rule_fallback",
    prompt_version: LLM_EXTRACTOR_PROMPT_VERSION,
    degraded: true,
    llm_failures: failures,
  });
}

function withMetadata<T extends ExtractionResult>(result: T, metadata: Record<string, unknown>): T {
  return {
    ...result,
    extractor_metadata: {
      ...(result.extractor_metadata ?? {}),
      ...metadata,
    },
  };
}

function classifyLlmError(error: unknown): { reason: LlmFailureReason; detail: string } {
  if (error instanceof LlmHttpError) return { reason: "http_error", detail: error.message };
  if (error instanceof LlmParseError) return { reason: "parse_error", detail: error.message };
  if (error instanceof LlmEmptyResponseError) return { reason: "empty_response", detail: error.message };
  if (isAbortError(error)) return { reason: "timeout", detail: errorMessage(error) };
  if (error instanceof SyntaxError || /不是 JSON 对象|JSON/.test(errorMessage(error))) return { reason: "parse_error", detail: errorMessage(error) };
  if (error instanceof TypeError) return { reason: "network_error", detail: error.message };
  return { reason: "unknown", detail: errorMessage(error) };
}

class LlmHttpError extends Error {}
class LlmParseError extends Error {}
class LlmEmptyResponseError extends Error {}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
