import type { CandidateWindow } from "../candidate/window.js";
import { loadLlmConfig } from "../llm/config.js";
import type { ExtractionResult } from "./decisionTypes.js";
import { callOpenAICompatibleWithRetry, errorMessage } from "./llm/client.js";
import { normalizeExtractionResult, parseJsonObject } from "./llm/parser.js";
import { degradedFallback, postProcessLlmResult, withMetadata } from "./llm/postprocess.js";
import { buildPrompt } from "./llm/prompt.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  LLM_EXTRACTOR_PROMPT_VERSION,
  type LlmExtractorOptions,
} from "./llm/types.js";

/**
 * 用 LLM 从候选窗口抽取结构化项目决策记忆。
 *
 * 管线：prompt 构造 → HTTP 重试 → JSON 解析 → 归一化 → 业务后处理（risk 纠正）
 *       → 附加 extractor_metadata。
 *
 * 任一阶段失败：
 * - options.fallback=true：走规则 baseline + degraded 元数据
 * - 否则：抛出描述性 Error，由调用方决定如何处理
 */
export async function extractDecisionWithLlm(
  window: CandidateWindow,
  options: LlmExtractorOptions = {},
): Promise<ExtractionResult> {
  const config = options.config ?? loadLlmConfig();
  if (!config) {
    if (options.fallback) {
      return degradedFallback(window, [{ attempt: 0, reason: "missing_config", detail: "LLM 配置缺失" }]);
    }
    throw new Error("LLM 配置缺失：请设置 KAIROS_LLM_BASE_URL / KAIROS_LLM_API_KEY / KAIROS_LLM_MODEL");
  }

  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const prompt = buildPrompt(window, { maxInputChars });
  const call = await callOpenAICompatibleWithRetry(config, prompt, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    fetchImpl: options.fetchImpl ?? fetch,
  });

  if (call.ok) {
    try {
      const normalized = postProcessLlmResult(
        normalizeExtractionResult(parseJsonObject(call.content), window),
        window,
      );
      return withMetadata(normalized, {
        extractor: "llm",
        prompt_version: LLM_EXTRACTOR_PROMPT_VERSION,
        attempts: call.attempts,
        truncated: window.denoised_text.length > maxInputChars,
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

// ---------- 对外兼容导出（给测试和其它模块使用） ----------
export { LLM_EXTRACTOR_PROMPT_VERSION } from "./llm/types.js";
export { parseJsonObject, normalizeExtractionResult } from "./llm/parser.js";
export type { LlmExtractorOptions } from "./llm/types.js";
