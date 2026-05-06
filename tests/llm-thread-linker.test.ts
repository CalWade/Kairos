import { describe, expect, it } from "vitest";
import { linkThreadsWithLlm } from "../src/candidate/llmThreadLinker.js";
import type { NormalizedMessage } from "../src/candidate/types.js";

function msg(id: string, text: string): NormalizedMessage {
  return { id, text, sender: "u", timestamp: 1000, mentions: [], links: [], doc_tokens: [], task_ids: [], source: "feishu_chat" };
}

function mockFetch(content: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status: 200 })) as typeof fetch;
}

describe("linkThreadsWithLlm", () => {
  it("按 LLM JSON 输出线程，并过滤不存在的 message_id", async () => {
    const result = await linkThreadsWithLlm([msg("m1", "PostgreSQL 太重"), msg("m2", "hooks 路径错了"), msg("m3", "先用 SQLite")], {
      config: { provider: "openai_compatible", baseUrl: "https://example.com/v1", apiKey: "k", model: "m" },
      fetchImpl: mockFetch({ threads: [
        { id: "db", message_ids: ["m1", "m3", "missing"], topic_hint: "数据库选型", confidence: 0.9, reasoning: "同一数据库讨论" },
        { id: "hooks", message_ids: ["m2"], topic_hint: "hooks", confidence: 0.8 },
      ] }),
    });
    expect(result.degraded).toBe(false);
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0].message_ids).toEqual(["m1", "m3"]);
  });

  it("缺配置时降级并标记 degraded", async () => {
    const result = await linkThreadsWithLlm([msg("m1", "PostgreSQL 太重")], { config: null });
    expect(result.degraded).toBe(true);
    expect(result.threads[0].message_ids).toEqual(["m1"]);
  });

  it("LLM 返回非法 JSON 时降级", async () => {
    const result = await linkThreadsWithLlm([msg("m1", "PostgreSQL 太重")], {
      config: { provider: "openai_compatible", baseUrl: "https://example.com/v1", apiKey: "k", model: "m" },
      fetchImpl: mockFetch("not json"),
    });
    expect(result.degraded).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it("兼容 reasoning 模型关闭 thinking 后的别名字段 messages / theme", async () => {
    const result = await linkThreadsWithLlm([msg("m1", "一"), msg("m2", "二"), msg("m3", "三")], {
      config: { provider: "openai_compatible", baseUrl: "https://example.com/v1", apiKey: "k", model: "m" },
      fetchImpl: mockFetch({ threads: [
        { thread_id: "t1", theme: "话题 A", messages: ["m1", "m3"] },
        { thread_id: "t2", theme: "话题 B", messages: ["m2"] },
      ] }),
    });
    expect(result.degraded).toBe(false);
    expect(result.threads.map((t) => t.message_ids)).toEqual([["m1", "m3"], ["m2"]]);
    expect(result.threads[0].topic_hint).toBe("话题 A");
  });

  it("timeout 超时时降级且保留 abort 错误", async () => {
    const slowFetch = (async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const result = await linkThreadsWithLlm([msg("m1", "测试")], {
      config: { provider: "openai_compatible", baseUrl: "https://example.com/v1", apiKey: "k", model: "m" },
      fetchImpl: slowFetch,
      timeoutMs: 50,
    });
    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/abort/i);
    expect(result.threads[0].message_ids).toEqual(["m1"]);
  });
});
