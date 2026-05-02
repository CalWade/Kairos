import { describe, expect, it } from "vitest";
import { checkLarkCliStatus } from "../src/larkCliAdapter.js";

describe("lark-cli adapter", () => {
  it("status check never throws", () => {
    const status = checkLarkCliStatus();
    expect(typeof status.installed).toBe("boolean");
    expect(status.auth_checked).toBe(false);
  });
});
