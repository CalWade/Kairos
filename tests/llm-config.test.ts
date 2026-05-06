import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeLlmConfig } from "../src/llm/config.js";

function tempEnv(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-llm-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("llm config preflight", () => {
  it("报告缺失的 LLM 配置项", () => {
    const envPath = tempEnv("KAIROS_LLM_BASE_URL=https://example.test/api\n");
    const info = describeLlmConfig(envPath, {});
    expect(info.ok).toBe(false);
    expect(info.missing).toContain("KAIROS_LLM_API_KEY");
    expect(info.missing).toContain("KAIROS_LLM_MODEL");
  });

  it("配置完整时返回模型摘要但不泄露 API Key", () => {
    const envPath = tempEnv([
      "KAIROS_LLM_BASE_URL=https://example.test/api",
      "KAIROS_LLM_API_KEY=secret",
      "KAIROS_LLM_MODEL=kairos-test-model",
    ].join("\n"));
    const info = describeLlmConfig(envPath, {});
    expect(info.ok).toBe(true);
    expect(info.baseUrl).toBe("https://example.test/api");
    expect(info.model).toBe("kairos-test-model");
    expect(info.hasApiKey).toBe(true);
    expect(JSON.stringify(info)).not.toContain("secret");
  });
});
