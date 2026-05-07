import type { LlmConfig } from "../../llm/config.js";

export const LLM_EXTRACTOR_PROMPT_VERSION = "llm-extractor-v0.2";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_MAX_INPUT_CHARS = 3_000;

export type FetchLike = typeof fetch;

export type LlmExtractorOptions = {
  config?: LlmConfig;
  timeoutMs?: number;
  fallback?: boolean;
  maxAttempts?: number;
  maxInputChars?: number;
  fetchImpl?: FetchLike;
};

export type LlmFailureReason =
  | "missing_config"
  | "timeout"
  | "http_error"
  | "parse_error"
  | "empty_response"
  | "network_error"
  | "unknown";

export type LlmAttemptFailure = {
  attempt: number;
  reason: LlmFailureReason;
  detail: string;
};

export type LlmCallResult =
  | { ok: true; content: string; attempts: number }
  | { ok: false; failures: LlmAttemptFailure[] };
