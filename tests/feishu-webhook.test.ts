import { describe, expect, it } from "vitest";
import { redactWebhookUrl } from "../src/feishuWebhook.js";
import { loadEnvValue } from "../src/llm/config.js";

describe("Feishu webhook helpers", () => {
  it("redactWebhookUrl 不泄露完整 token", () => {
    const redacted = redactWebhookUrl("https://open.feishu.cn/open-apis/bot/v2/hook/abcdef1234567890");
    expect(redacted).toContain("abcd...7890");
    expect(redacted).not.toContain("abcdef1234567890");
  });

  it("loadEnvValue 优先读取环境变量", () => {
    expect(loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL", ".env.not-exist", { KAIROS_FEISHU_WEBHOOK_URL: "https://example.test/hook" })).toBe("https://example.test/hook");
  });
});
