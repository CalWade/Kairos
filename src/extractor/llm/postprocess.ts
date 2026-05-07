import type { CandidateWindow } from "../../candidate/window.js";
import type { ExtractionResult } from "../decisionTypes.js";
import { extractDecisionBaseline } from "../ruleDecisionExtractor.js";
import type { LlmAttemptFailure } from "./types.js";
import { LLM_EXTRACTOR_PROMPT_VERSION } from "./types.js";

/**
 * LLM 把某些 "API Key / 前端直连 / 生产环境" 类消息初判为 convention；
 * 这些其实是 risk，需要在后处理里把 kind 纠正过来，顺便补 severity / impact / mitigation。
 */
export function postProcessLlmResult(result: ExtractionResult, window: CandidateWindow): ExtractionResult {
  if (result.kind === "convention" && /API Key|密钥|前端直连|生产环境|泄露|安全边界|权限|故障|乱码|独立\s*IP/i.test(
    `${window.denoised_text}
${result.rule}
${result.topic}`,
  )) {
    return {
      kind: "risk",
      confidence: Math.max(0.6, result.confidence),
      evidence_message_ids: result.evidence_message_ids,
      aliases: [...new Set([...(result.aliases ?? []), "API Key", "安全边界", "风险"])],
      negative_keys: result.negative_keys,
      reasoning: `LLM 初判为 convention，但命中安全/生产风险边界，按 risk 处理：${result.reasoning}`,
      should_remember: result.should_remember,
      reject_reason: result.reject_reason,
      topic: /API Key|密钥/i.test(window.denoised_text) ? "api_key_policy" : "project_risk",
      risk: result.rule,
      impact: /前端直连|泄露/i.test(window.denoised_text) ? "可能造成密钥泄露或越权访问" : undefined,
      mitigation: /服务端|代理/i.test(window.denoised_text) ? "通过服务端代理使用敏感凭据" : undefined,
      severity: "high",
    };
  }
  return result;
}

/**
 * LLM 全部重试失败时的兜底：走规则 baseline 抽取，并把 degraded 信息
 * 和原始 LLM 失败记录写进 extractor_metadata，保证可审计。
 */
export function degradedFallback(window: CandidateWindow, failures: LlmAttemptFailure[]): ExtractionResult {
  const fallback = extractDecisionBaseline(window);
  return withMetadata(fallback, {
    extractor: "rule_fallback",
    prompt_version: LLM_EXTRACTOR_PROMPT_VERSION,
    degraded: true,
    llm_failures: failures,
  });
}

export function withMetadata<T extends ExtractionResult>(result: T, metadata: Record<string, unknown>): T {
  return {
    ...result,
    extractor_metadata: {
      ...(result.extractor_metadata ?? {}),
      ...metadata,
    },
  };
}
