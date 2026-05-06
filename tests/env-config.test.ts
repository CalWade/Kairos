import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvValue } from "../src/llm/config.js";

function tempEnv(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("env config", () => {
  it("从 .env 读取 lark runtime 配置", () => {
    const envPath = tempEnv([
      "KAIROS_LARK_PROFILE=kairos-alt",
      "KAIROS_CHAT_ID=oc_demo",
      "KAIROS_FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/demo",
    ].join("\n"));

    expect(loadEnvValue("KAIROS_LARK_PROFILE", envPath, {})).toBe("kairos-alt");
    expect(loadEnvValue("KAIROS_CHAT_ID", envPath, {})).toBe("oc_demo");
    expect(loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL", envPath, {})).toContain("hook/demo");
  });

  it("环境变量优先于 .env，方便临时覆盖", () => {
    const envPath = tempEnv("KAIROS_CHAT_ID=oc_from_file\n");
    expect(loadEnvValue("KAIROS_CHAT_ID", envPath, { KAIROS_CHAT_ID: "oc_from_shell" })).toBe("oc_from_shell");
  });
});
