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

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
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
