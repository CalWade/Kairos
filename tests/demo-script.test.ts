import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";

describe("demo-e2e script", () => {
  it("存在且使用临时数据库避免污染默认 data", () => {
    const stat = statSync("scripts/demo-e2e.sh");
    const content = readFileSync("scripts/demo-e2e.sh", "utf8");

    expect(stat.mode & 0o111).toBeGreaterThan(0);
    expect(content).toContain("mktemp");
    expect(content).toContain("memory.db");
    expect(content).toContain("decision-card");
    expect(content).toContain("eval --core");
  });
});
