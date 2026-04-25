import { readFileSync } from "node:fs";

export type SmokeCase = {
  id: string;
  category: string;
  input: string[];
  query: string;
  expected: string;
};

export function loadSmokeCases(path = "eval/datasets/smoke.jsonl"): SmokeCase[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SmokeCase);
}

export function summarizeSmokeCases(cases: SmokeCase[]) {
  const byCategory = new Map<string, number>();
  for (const item of cases) {
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
  }
  return {
    total: cases.length,
    categories: Object.fromEntries(byCategory.entries()),
  };
}
