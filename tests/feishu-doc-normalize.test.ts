import { describe, expect, it } from "vitest";
import { normalizeFeishuMarkdown, splitMarkdownBlocks } from "../src/candidate/feishuDoc.js";

describe("normalizeFeishuMarkdown", () => {
  it("按标题、段落、列表切分飞书 Markdown", () => {
    const markdown = `# 第一周期\n### 一、核心产出\n本周期确定项目方向为 Kairos。\n- 设计 MemoryAtom\n- 初始化 GitHub 仓库\n\n### 二、量化指标\n完成 5 个 smoke case。`;

    const blocks = splitMarkdownBlocks(markdown);

    expect(blocks).toContain("# 第一周期");
    expect(blocks).toContain("### 一、核心产出");
    expect(blocks).toContain("本周期确定项目方向为 Kairos。");
    expect(blocks).toContain("- 设计 MemoryAtom\n- 初始化 GitHub 仓库");
  });

  it("转成 feishu_doc 标准消息并抽取链接", () => {
    const messages = normalizeFeishuMarkdown("参考文档 https://example.feishu.cn/wiki/ABC123", {
      title: "测试文档",
      docToken: "ABC123",
      baseTimestamp: 1_000,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].source).toBe("feishu_doc");
    expect(messages[0].sender).toBe("测试文档");
    expect(messages[0].doc_tokens).toContain("ABC123");
  });
});
