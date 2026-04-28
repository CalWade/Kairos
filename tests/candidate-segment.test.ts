import { describe, expect, it } from "vitest";
import { normalizeTextLines } from "../src/candidate/normalize.js";
import { segmentMessages } from "../src/candidate/segment.js";

describe("segmentMessages", () => {
  it("按时间间隔切分不同讨论", () => {
    const messages = normalizeTextLines("张三：决定用 SQLite\n李四：确认\n王五：周报发给 Bob", {
      baseTimestamp: 1_000,
      intervalMs: 20 * 60 * 1000,
      source: "feishu_chat",
    });

    const segments = segmentMessages(messages, { maxGapMs: 15 * 60 * 1000 });

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[1].boundary_reasons).toContain("time_gap");
  });

  it("将同一数据库讨论保持在一个 segment", () => {
    const messages = normalizeTextLines("张三：我们用 SQLite 还是 PostgreSQL？\n李四：SQLite 部署简单\n王五：最终决定 MVP 用 SQLite", {
      baseTimestamp: 1_000,
      intervalMs: 60_000,
      source: "feishu_chat",
    });

    const segments = segmentMessages(messages);

    expect(segments).toHaveLength(1);
    expect(segments[0].topic_hint).toBe("database_or_storage");
  });

  it("标题会附着到后续正文 segment", () => {
    const messages = normalizeTextLines("## 数据库选型\n张三：最终决定用 SQLite", {
      baseTimestamp: 1_000,
      source: "feishu_doc",
    });

    const segments = segmentMessages(messages);

    expect(segments).toHaveLength(1);
    expect(segments[0].messages[0].text).toBe("## 数据库选型");
  });
});
