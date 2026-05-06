import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOpenAIChatBody, describeLlmConfig, isThinkingDisabled } from "../src/llm/config.js";

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

describe("isThinkingDisabled", () => {
  it("默认关（未配置则返回 false）", () => {
    const envPath = tempEnv("");
    expect(isThinkingDisabled(envPath, {})).toBe(false);
  });

  it("支持 1/true/yes/on 多种真值写法", () => {
    for (const val of ["1", "true", "TRUE", "yes", "on"]) {
      const envPath = tempEnv(`KAIROS_LLM_DISABLE_THINKING=${val}\n`);
      expect(isThinkingDisabled(envPath, {}), `value=${val}`).toBe(true);
    }
  });

  it("进程 env 优先于 .env 文件", () => {
    const envPath = tempEnv("KAIROS_LLM_DISABLE_THINKING=0\n");
    expect(isThinkingDisabled(envPath, { KAIROS_LLM_DISABLE_THINKING: "1" })).toBe(true);
  });
});

describe("buildOpenAIChatBody", () => {
  const config = { provider: "openai_compatible" as const, baseUrl: "https://x/v1", apiKey: "k", model: "m-1" };

  it("默认不带 thinking 字段", () => {
    const body = buildOpenAIChatBody(config, {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
      disableThinking: false,
    });
    expect(body.model).toBe("m-1");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0);
    expect(body.thinking).toBeUndefined();
  });

  it("disableThinking=true 时带 thinking: disabled", () => {
    const body = buildOpenAIChatBody(config, {
      messages: [{ role: "user", content: "hi" }],
      disableThinking: true,
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("不传 disableThinking 时读环境变量（本测试进程未设置 → false）", () => {
    const before = process.env.KAIROS_LLM_DISABLE_THINKING;
    delete process.env.KAIROS_LLM_DISABLE_THINKING;
    try {
      const body = buildOpenAIChatBody(config, { messages: [{ role: "user", content: "hi" }] });
      expect(body.thinking).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.KAIROS_LLM_DISABLE_THINKING = before;
    }
  });

  it("temperature 可覆盖，不传默认 0", () => {
    expect(buildOpenAIChatBody(config, { messages: [], temperature: 0.7 }).temperature).toBe(0.7);
    expect(buildOpenAIChatBody(config, { messages: [] }).temperature).toBe(0);
  });
});
