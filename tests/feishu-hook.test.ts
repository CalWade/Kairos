import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("kairos-feishu-ingress hook", () => {
  it("声明监听 message:received 并调用 feishu-workflow", () => {
    const meta = readFileSync("hooks/kairos-feishu-ingress/HOOK.md", "utf8");
    const handler = readFileSync("hooks/kairos-feishu-ingress/handler.ts", "utf8");

    expect(meta).toContain("message:received");
    expect(handler).toContain("feishu-workflow");
    expect(handler).toContain("KAIROS_HOOK_SEND_FEISHU");
    expect(handler).toContain("runs/kairos-feishu-ingress.jsonl");
  });
});
