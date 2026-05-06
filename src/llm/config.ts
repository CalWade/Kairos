import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type LlmConfig = {
  provider: "openai_compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function loadLlmConfig(envPath = ".env", env: NodeJS.ProcessEnv = process.env): LlmConfig | undefined {
  const fileEnv = readEnvFile(resolve(envPath));
  const merged = { ...fileEnv, ...env };
  const baseUrl = merged.KAIROS_LLM_BASE_URL;
  const apiKey = merged.KAIROS_LLM_API_KEY;
  const model = merged.KAIROS_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return undefined;
  return {
    provider: "openai_compatible",
    baseUrl,
    apiKey,
    model,
  };
}

export function loadEnvValue(key: string, envPath = ".env", env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fileEnv = readEnvFile(resolve(envPath));
  return env[key] ?? fileEnv[key];
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

/**
 * 读取 KAIROS_LLM_DISABLE_THINKING；真值（1/true/yes/on）表示应在请求体里带
 * thinking: { type: "disabled" }，适用于火山方舟 Doubao-Thinking / Seed-Thinking
 * 等 reasoning 模型，能把 LLM 延迟从 30-60s 压到 3-5s。
 */
export function isThinkingDisabled(envPath = ".env", env: NodeJS.ProcessEnv = process.env): boolean {
  const fileEnv = readEnvFile(resolve(envPath));
  const raw = (env.KAIROS_LLM_DISABLE_THINKING ?? fileEnv.KAIROS_LLM_DISABLE_THINKING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export type OpenAIChatBodyInput = {
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  /** 显式开关；不传时读取 KAIROS_LLM_DISABLE_THINKING */
  disableThinking?: boolean;
};

/**
 * 统一构造 OpenAI-compatible chat completions 请求体。
 * - 所有 LLM 调用点共享温度/token 限制的拼接方式；
 * - 支持 vendor-specific thinking 关闭；对不识别该字段的 vendor（OpenAI 官方）
 *   飞书方舟外的大多数实现会忽略未知字段，兼容性良好。
 */
export function buildOpenAIChatBody(config: LlmConfig, input: OpenAIChatBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: input.messages,
    temperature: input.temperature ?? 0,
  };
  if (typeof input.maxTokens === "number") body.max_tokens = input.maxTokens;
  const disable = input.disableThinking ?? isThinkingDisabled();
  if (disable) body.thinking = { type: "disabled" };
  return body;
}

export function describeLlmConfig(envPath = ".env", env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  missing: string[];
  baseUrl?: string;
  model?: string;
  hasApiKey: boolean;
} {
  const fileEnv = readEnvFile(resolve(envPath));
  const merged = { ...fileEnv, ...env };
  const required = ["KAIROS_LLM_BASE_URL", "KAIROS_LLM_API_KEY", "KAIROS_LLM_MODEL"];
  const missing = required.filter((key) => !merged[key]);
  return {
    ok: missing.length === 0,
    missing,
    baseUrl: merged.KAIROS_LLM_BASE_URL,
    model: merged.KAIROS_LLM_MODEL,
    hasApiKey: !!merged.KAIROS_LLM_API_KEY,
  };
}

export async function testLlmConnection(input: { config?: LlmConfig; timeoutMs?: number } = {}): Promise<{ ok: boolean; model?: string; error?: string }> {
  const config = input.config ?? loadLlmConfig();
  if (!config) return { ok: false, error: "missing_llm_config" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Return exactly: OK" }],
        temperature: 0,
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, model: config.model, error: `HTTP ${response.status} ${text.slice(0, 200)}` };
    return { ok: true, model: config.model };
  } catch (error) {
    return { ok: false, model: config.model, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    result[key] = value;
  }
  return result;
}
