import { buildOpenAIChatBody, chatCompletionsUrl, type LlmConfig } from "../../llm/config.js";
import { parseJsonObject } from "./parser.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { FetchLike, LlmAttemptFailure, LlmCallResult, LlmFailureReason } from "./types.js";

export class LlmHttpError extends Error {}
export class LlmParseError extends Error {}
export class LlmEmptyResponseError extends Error {}

/**
 * 多次重试调用 OpenAI-compatible chat completions。
 * 每次尝试都要求能 parseJsonObject 成功，否则记为失败继续下一次重试。
 * 返回结构化的 {ok, content, attempts} 或 {ok:false, failures}，由上层决定是否 degrade。
 */
export async function callOpenAICompatibleWithRetry(
  config: LlmConfig,
  prompt: string,
  options: { timeoutMs: number; maxAttempts: number; fetchImpl: FetchLike },
): Promise<LlmCallResult> {
  const failures: LlmAttemptFailure[] = [];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const content = await callOpenAICompatible(config, prompt, options.timeoutMs, options.fetchImpl);
      // 非法 JSON 按可重试失败处理，而非最终成功
      parseJsonObject(content);
      return { ok: true, content, attempts: attempt };
    } catch (error) {
      failures.push({ attempt, ...classifyLlmError(error) });
    }
  }
  return { ok: false, failures };
}

async function callOpenAICompatible(
  config: LlmConfig,
  prompt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildOpenAIChatBody(config, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        maxTokens: 1200,
      })),
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

export function classifyLlmError(error: unknown): { reason: LlmFailureReason; detail: string } {
  if (error instanceof LlmHttpError) return { reason: "http_error", detail: error.message };
  if (error instanceof LlmParseError) return { reason: "parse_error", detail: error.message };
  if (error instanceof LlmEmptyResponseError) return { reason: "empty_response", detail: error.message };
  if (isAbortError(error)) return { reason: "timeout", detail: errorMessage(error) };
  if (error instanceof SyntaxError || /不是 JSON 对象|JSON/.test(errorMessage(error))) {
    return { reason: "parse_error", detail: errorMessage(error) };
  }
  if (error instanceof TypeError) return { reason: "network_error", detail: error.message };
  return { reason: "unknown", detail: errorMessage(error) };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && !Array.isArray(error) &&
    (error as { name?: string }).name === "AbortError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message?.slice(0, 200) ?? "";
  } catch {
    return text.slice(0, 120);
  }
}
