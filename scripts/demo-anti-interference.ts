#!/usr/bin/env tsx
/**
 * Kairos 硬核抗干扰测试可视化
 *
 * 读 eval/datasets/anti-interference.jsonl 里 anti_storage_hardcore_100 case，
 * 完整跑一遍（101 条 memory 进 Store → search 取 top-5），
 * 美化输出让评委一眼看到"100+1 噪声中目标排名第一"。
 *
 * 运行：
 *   npm run demo:anti-interference
 *   或：tsx scripts/demo-anti-interference.ts --case anti_storage_hardcore_100
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractDecisionBaseline } from "../src/extractor/ruleDecisionExtractor.js";
import { extractionToMemoryAtom } from "../src/extractor/toMemoryAtom.js";
import { MemoryStore } from "../src/memory/store.js";
import type { MemoryAtom } from "../src/memory/atom.js";
import type { CandidateWindow } from "../src/candidate/window.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DEFAULT_DATASET = join(ROOT, "eval", "datasets", "anti-interference.jsonl");

// ANSI 颜色（纯文本输出时自动关闭）
const useColor = process.stdout.isTTY;
const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => c("1", t);
const dim = (t: string) => c("2", t);
const green = (t: string) => c("32", t);
const yellow = (t: string) => c("33", t);
const red = (t: string) => c("31", t);
const cyan = (t: string) => c("36", t);
const magenta = (t: string) => c("35", t);

type Case = {
  id: string;
  description?: string;
  memories: string[];
  query: string;
  expected_contains?: string[];
  expected_not_contains?: string[];
  expected_hit_rank?: number;
};

function window(text: string): CandidateWindow {
  return {
    id: `eval_${Math.random().toString(36).slice(2, 10)}`,
    segment_id: "eval_segment",
    topic_hint: "anti_interference",
    salience_score: 1,
    salience_signals: [],
    candidate_eligible: true,
    denoised_text: text,
    evidence_message_ids: ["eval_message"],
    dropped_message_ids: [],
    estimated_tokens: Math.ceil(text.length / 2),
  };
}

function loadCase(datasetPath: string, caseId: string): Case {
  const lines = readFileSync(datasetPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.id === caseId) return parsed;
  }
  throw new Error(`找不到 case: ${caseId} in ${datasetPath}`);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

function padDisplay(text: string, width: number): string {
  // 中英文混排粗略等宽：中文/全角算 2，其他算 1
  let visual = 0;
  for (const ch of text) visual += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return text + " ".repeat(Math.max(0, width - visual));
}

function divider(char = "─", len = 82): string {
  return dim(char.repeat(len));
}

function main() {
  const { values } = parseArgs({
    options: {
      case: { type: "string", default: "anti_storage_hardcore_100" },
      dataset: { type: "string", default: DEFAULT_DATASET },
      top: { type: "string", default: "5" },
    },
  });

  const caseData = loadCase(values.dataset!, values.case!);
  const topK = Number(values.top);

  // 头部介绍
  console.log();
  console.log(bold(magenta("━━━ Kairos 硬核抗干扰测试 ━━━")));
  console.log();
  console.log(`${dim("Case ID        :")} ${caseData.id}`);
  if (caseData.description) console.log(`${dim("场景           :")} ${caseData.description}`);
  console.log(`${dim("输入记忆候选数 :")} ${bold(String(caseData.memories.length))} 条  ${dim("(真实感群聊噪声 + 目标决策)")}`);
  console.log(`${dim("查询           :")} ${cyan(`"${caseData.query}"`)}`);
  console.log(`${dim("预期命中位置   :")} top-${caseData.expected_hit_rank ?? 1}`);
  console.log();

  // 构建临时 Store，灌入 101 条记忆
  const dir = mkdtempSync(join(tmpdir(), "kairos-anti-"));
  const storePath = join(dir, "memory.db");
  const eventsPath = join(dir, "events.jsonl");

  process.stdout.write(dim(`Step 1/3  规则抽取器过滤 ${caseData.memories.length} 条输入 ... `));
  const tStart = Date.now();
  try {
    const store = new MemoryStore(storePath, eventsPath);
    let ingested = 0;
    let rejected = 0;
    for (const memory of caseData.memories) {
      const win = window(memory);
      const extraction = extractDecisionBaseline(win);
      const atom = extractionToMemoryAtom(extraction, win, "kairos");
      if (atom) {
        store.upsert(atom);
        ingested++;
      } else {
        rejected++;
      }
    }
    const ingestMs = Date.now() - tStart;
    console.log(green(`✓ ${ingestMs}ms`));
    console.log(dim(`          └─ ${bold(green(`${ingested} 条`))} 被抽取为 MemoryAtom 进入 Store`));
    console.log(dim(`          └─ ${bold(yellow(`${rejected} 条`))} 被规则抽取器识别为噪声直接丢弃 ${dim("(闲聊/通知/外卖/打印机等)")}`));
    console.log();

    const typeStats: Record<string, number> = {};
    for (const atom of store.list({ limit: caseData.memories.length * 2 })) {
      typeStats[atom.type] = (typeStats[atom.type] ?? 0) + 1;
    }
    const typeStr = Object.entries(typeStats).map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(dim(`Step 2/3  Store 内 ${ingested} 条 MemoryAtom 类型分布：${typeStr}`));
    console.log();

    // 跑 search
    process.stdout.write(dim(`Step 3/3  在 Store 内搜索 "${caseData.query}" ... `));
    const tQuery = Date.now();
    const hits = store.search(caseData.query, { project: "kairos", limit: topK });
    const queryMs = Date.now() - tQuery;
    console.log(green(`✓ ${queryMs}ms, 返回 top-${hits.length}`));
    console.log();

    // 找目标位置
    const targetIdx = hits.findIndex((hit) =>
      (caseData.expected_contains ?? []).every((needle) => hit.content.includes(needle))
    );
    const targetRank = targetIdx >= 0 ? targetIdx + 1 : undefined;

    // 输出 Top-K 表格
    console.log(bold(`Top-${topK} 召回结果：`));
    console.log(divider());
    console.log(`  ${padDisplay(bold("#"), 3)}  ${padDisplay(bold("命中?"), 6)}  ${padDisplay(bold("type"), 12)}  ${bold("content (前 60 字)")}`);
    console.log(divider());
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const isTarget = i === targetIdx;
      const marker = isTarget ? green("🎯 目标") : dim("   —  ");
      const rank = isTarget ? bold(green(`#${i + 1}`)) : dim(`#${i + 1}`);
      const type = isTarget ? bold(yellow(hit.type)) : dim(hit.type);
      const content = isTarget
        ? green(truncate(hit.content, 60))
        : dim(truncate(hit.content, 60));
      console.log(`  ${padDisplay(rank, 3)}  ${padDisplay(marker, 6)}  ${padDisplay(type, 12)}  ${content}`);
    }
    console.log(divider());
    console.log();

    // 结论
    const expectedRank = caseData.expected_hit_rank ?? 1;
    const containsOk = targetRank !== undefined &&
      (caseData.expected_contains ?? []).every((needle) => hits[targetIdx].content.includes(needle));
    const notContainsOk = targetRank !== undefined &&
      (caseData.expected_not_contains ?? []).every((needle) => !hits[targetIdx].content.includes(needle));
    const rankOk = targetRank !== undefined && targetRank <= expectedRank;
    const pass = containsOk && notContainsOk && rankOk;

    if (pass) {
      console.log(green(bold(`✅ PASS`)) +
        `  目标决策定位到 top-${bold(green(String(targetRank)))}  ${dim(`(要求 ≤ ${expectedRank})`)}`);
      console.log();
      console.log(bold(`Kairos 的两阶段抗干扰：`));
      console.log(`  ${green("①")} ${rejected}/${caseData.memories.length} 条噪声在${bold("抽取阶段")}就被过滤（Rule Extractor 判断无决策价值）`);
      console.log(`  ${green("②")} 剩下 ${ingested} 条 MemoryAtom 中，${bold("结构化召回")}把目标定到第 ${targetRank} 位`);
      console.log();
      console.log(dim(`一句话：${caseData.memories.length - 1} 条真实感噪声中，目标决策既进得了 Store，又搜得出 top-1。`));
    } else {
      console.log(red(bold(`❌ FAIL`)));
      if (targetRank === undefined) {
        console.log(red(`  目标不在 top-${topK}`));
      } else {
        console.log(red(`  排名 ${targetRank}（要求 ≤ ${expectedRank}）`));
      }
      if (!containsOk) console.log(red(`  缺少关键词: ${(caseData.expected_contains ?? []).filter((n) => !hits[targetIdx]?.content.includes(n)).join(", ")}`));
      if (!notContainsOk) console.log(red(`  误含应排除词: ${(caseData.expected_not_contains ?? []).filter((n) => hits[targetIdx]?.content.includes(n)).join(", ")}`));
    }
    console.log();

    // 召回机制说明
    const target = targetRank !== undefined ? hits[targetIdx] : undefined;
    if (target) {
      const raw = (target.metadata as any)?.raw_extraction ?? {};
      const aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
      const negKeys = Array.isArray(raw.negative_keys) ? raw.negative_keys : [];
      if (aliases.length || negKeys.length) {
        console.log(dim(`召回机制（目标记忆里的反向检索 key）：`));
        if (aliases.length) console.log(dim(`  aliases       : ${aliases.slice(0, 6).join(", ")}${aliases.length > 6 ? " ..." : ""}`));
        if (negKeys.length) console.log(dim(`  negative_keys : ${negKeys.slice(0, 6).join(", ")}${negKeys.length > 6 ? " ..." : ""}`));
        console.log();
      }
    }

    console.log(dim(`说明：本测试基于 Kairos 自建小样本 benchmark，目的是证明召回在量级对比下仍可靠。`));
    console.log(dim(`      101 条记忆均为仿真群聊内容，不代表真实线上噪声分布。详见 docs/benchmark-report.md §7。`));
    console.log();

    if (!pass) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
