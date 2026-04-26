import { createHash } from "node:crypto";

export function makeMemoryId(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `mem_${hash}`;
}
