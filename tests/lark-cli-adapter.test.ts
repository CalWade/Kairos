import { describe, expect, it } from "vitest";
import { buildLarkCliPlan, checkLarkCliStatus, extractTextsFromLarkCliJson, preflightLarkCliPurpose } from "../src/larkCliAdapter.js";

describe("lark-cli adapter", () => {
  it("status check never throws", () => {
    const status = checkLarkCliStatus();
    expect(typeof status.installed).toBe("boolean");
    expect(status.auth_checked).toBe(false);
  });

  it("buildLarkCliPlan 生成消息搜索和文档读取命令但不执行", () => {
    expect(buildLarkCliPlan({ purpose: "message_search", query: "PostgreSQL" }).command).toContain("+messages-search");
    expect(buildLarkCliPlan({ purpose: "doc_fetch", docUrl: "https://example.feishu.cn/wiki/xxx" }).command).toContain("+fetch");
  });

  it("profile in plan", () => {
    const command = buildLarkCliPlan({ purpose: "chat_messages", chatId: "oc_x", profile: "kairos-alt" }).command;
    expect(command).toContain("--profile");
    expect(command).toContain("kairos-alt");
    expect(command.filter((item) => item === "--profile")).toHaveLength(1);
  });

  it("preflightLarkCliPurpose can report missing scopes", () => {
    const preflight = preflightLarkCliPurpose("message_search");
    expect(preflight.required_scopes).toContain("search:message");
  });

  it("过滤 app 卡片和授权链接噪声", () => {
    const texts = extractTextsFromLarkCliJson({ data: { messages: [
      { message_id: "app_1", msg_type: "post", sender: { sender_type: "app" }, content: "<card>配置链接</card>" },
      { message_id: "user_1", msg_type: "text", sender: { sender_type: "user" }, content: "最终决定：先用 SQLite。" },
    ] } });
    expect(texts).toHaveLength(1);
    expect(texts[0].id).toBe("user_1");
  });

  it("extractTextsFromLarkCliJson 从常见 lark-cli 输出中提取文本", () => {
    const texts = extractTextsFromLarkCliJson({
      data: {
        items: [
          { message_id: "om_1", content: "{\"text\":\"最终决定使用 SQLite，不用 PostgreSQL。\"}", chat_id: "oc_1" },
          { id: "doc_1", text: "普通文档内容" },
        ],
      },
    });
    expect(texts.map((item) => item.text)).toContain("最终决定使用 SQLite，不用 PostgreSQL。");
    expect(texts.map((item) => item.id)).toContain("om_1");
  });
});
