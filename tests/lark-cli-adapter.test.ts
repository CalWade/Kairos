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

  it("preflightLarkCliPurpose can report missing scopes", () => {
    const preflight = preflightLarkCliPurpose("message_search");
    expect(preflight.required_scopes).toContain("search:message");
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
