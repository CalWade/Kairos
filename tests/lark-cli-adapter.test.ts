import { describe, expect, it } from "vitest";
import { buildLarkCliPlan, checkLarkCliStatus, extractChatInfoFromLarkCliJson, extractTextsFromLarkCliJson, preflightLarkCliPurpose, toNormalizedMessages } from "../src/larkCliAdapter.js";

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

  it("extractChatInfoFromLarkCliJson 从 chat-list 输出中解析群名称", () => {
    const chat = extractChatInfoFromLarkCliJson({
      data: {
        items: [
          { chat_id: "oc_demo", name: "Kairos Demo 群" },
          { chat_id: "oc_other", name: "其他群" },
        ],
      },
    }, "oc_demo");
    expect(chat).toEqual({ chat_id: "oc_demo", name: "Kairos Demo 群" });
  });

  it("toNormalizedMessages 保留完整元数据供线程恢复使用", () => {
    const messages = toNormalizedMessages({
      data: {
        messages: [
          {
            message_id: "om_1",
            sender: { name: "Alice", id: "ou_alice" },
            create_time: 1715000000000,
            chat_id: "oc_123",
            thread_id: "omt_thread_1",
            reply_to: "om_parent",
            content: "{\"text\":\"最终决定使用 SQLite。\"}",
          },
          {
            message_id: "om_2",
            sender: { name: "Bob", id: "ou_bob" },
            create_time: 1715000010000,
            chat_id: "oc_123",
            content: "{\"text\":\"同意，先按这个来。\"}",
          },
        ],
      },
    }, "oc_123");
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("om_1");
    expect(messages[0].sender).toBe("Alice");
    expect(messages[0].timestamp).toBe(1715000000000);
    expect(messages[0].chat_id).toBe("oc_123");
    expect(messages[0].thread_id).toBe("omt_thread_1");
    expect(messages[0].reply_to).toBe("om_parent");
    expect(messages[1].sender).toBe("Bob");
    expect(messages[1].thread_id).toBeUndefined();
  });
});
