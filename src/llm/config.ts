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
